(ns codewalk.activity
  "Local-only, bounded activity collection and Server-Sent Events transport.

  Live replay remains bounded in memory.  Optional metadata-only recordings are
  delegated to codewalk.activity-archive and never enter the live SSE stream."
  (:require
   [clojure.data.json :as json]
   [clojure.string :as str]
   [codewalk.activity-archive :as archive])
  (:import
   [com.sun.net.httpserver HttpExchange]
   [java.io IOException InputStream]
   [java.nio.charset StandardCharsets]
   [java.security MessageDigest]
   [java.security SecureRandom]
   [java.util Base64]
   [java.net URLDecoder]
   [java.time Instant OffsetDateTime]
   [java.util.concurrent ArrayBlockingQueue RejectedExecutionException
    TimeUnit]))

(def schema-version 1)
(def max-body-bytes (* 64 1024))
(def max-replay-events 256)
(def max-clients 64)
(def max-workspaces 64)
(def max-client-queue 128)
(def heartbeat-ms 15000)
(def unknown-workspace ::unknown)
(def all-workspaces ::all)
(def default-activity-origins
  #{"http://localhost:4180" "http://127.0.0.1:4180"
    "http://localhost:4173" "http://127.0.0.1:4173"})

(def required-fields
  #{:schemaVersion :id :sessionId :timestamp :type})

(def optional-fields
  #{:sequence :parentId :agentId :turnId :toolCallId :source :status :tool
    :snippet :sessionName :agentName :workspace :resources :content :metadata
    :redactedMetadata})

(def lifecycle-types
  "Known types are documented for clients, but unknown types are accepted so a
  schema-version-one producer remains forward compatible."
  #{"session.started" "session.ended"
    "prompt.submitted" "assistant.started" "assistant.delta"
    "assistant.completed"
    "tool.started" "tool.completed" "tool.failed"
    "agent.started" "agent.stopped" "permission.requested" "permission.resolved"
    "error.occurred"})

(def max-nesting-depth 4)

(defn- keywordize-top-level
  [value]
  (if (map? value)
    (into {}
          (map (fn [[key child]]
                 [(if (keyword? key) key (keyword (str key))) child]))
          value)
    value))

(defn- new-token
  []
  (let [bytes (byte-array 32)]
    (.nextBytes (SecureRandom.) bytes)
    (.encodeToString (Base64/getUrlEncoder) bytes)))

(defn- problem
  ([status code message] (problem status code message nil))
  ([status code message details]
   (throw (ex-info message
                   (cond-> {:status    status
                            :api-error true
                            :code      code}
                     details (assoc :details details))))))

(defn- bounded-string
  [value field limit]
  (when-not (string? value)
    (problem 400 "INVALID_EVENT" (str field " must be a string.")))
  (when (or (str/blank? value) (> (count value) limit))
    (problem
     400
     "INVALID_EVENT"
     (str field " must be non-blank and at most " limit " characters.")))
  value)

(defn- bounded-number
  [value field]
  (when-not (number? value)
    (problem 400 "INVALID_EVENT" (str field " must be a number.")))
  value)

(def sensitive-fields
  #{:prompt :message :command :arguments :result :output :code :headers :env
    :content})

(def safe-field-specs
  {:id           [:string 256]
   :name         [:string 256]
   :path         [:string 1024]
   :file         [:string 1024]
   :relativePath [:string 1024]
   :ref          [:string 512]
   :kind         [:string 64]
   :nodeId       [:string 256]
   :graphNodeId  [:string 256]
   :sessionName  [:string 256]
   :agentName    [:string 256]
   :status       [:string 64]
   :summary      [:summary 256]
   :snippet      [:summary 256]
   :provider     [:string 128]
   :providerEventType   [:string 128]
   :providerToolCallId  [:string 256]
   :providerMessageId   [:string 256]
   :errorClassification [:string 64]
   :errorCode           [:string 64]
   :client              [:string 64]
   :version             [:string 64]
   :action              [:string 32]
   :confidence          [:string 32]
   :scope        [:string 128]
   :availability [:string 32]
   :coverage     [:string 32]
   :branch       [:string 256]
   :repository   [:string 512]
   :root         [:string 4096]
   :worktree     [:string 1024]
   :workspaceId  [:string 256]
   :repoId       [:string 256]
   :durationMs   [:non-negative-number nil]
   :count        [:non-negative-number nil]
   :line         [:non-negative-number nil]
   :column       [:non-negative-number nil]
   :startLine    [:non-negative-number nil]
   :endLine      [:non-negative-number nil]
   :endColumn    [:non-negative-number nil]
   :span         [:span nil]
   :available    [:boolean nil]
   :outsideRoot         [:boolean nil]
   :unknownEvent        [:boolean nil]
   :contentAvailable    [:boolean nil]
   :targetAgentId       [:string 256]
   :targetAgentNodeId   [:string 256]
   :targetSessionId     [:string 256]
   :targetWorkspaceId   [:string 256]
   :redacted     [:boolean nil]
   :permissionResult [:pattern-string 64 #"^[a-z][a-z0-9-]{0,63}$"]
   :permissionKind   [:pattern-string 64 #"^[a-z][a-z0-9-]{0,63}$"]
   :exitCode         [:bounded-integer -2147483648 2147483648]
   :bytes            [:non-negative-number nil]})

(defn- key-name
  [key]
  (if (keyword? key) (name key) (str key)))

(defn- validate-span
  [value field]
  (when-not (map? value)
   (problem 400 "INVALID_EVENT" (str field " must be a span metadata map.")))
  (when (> (count value) 2)
   (problem 400 "INVALID_EVENT" (str field " has too many entries.")))
  (doseq [[point-key point] value]
   (let [point-key (if (keyword? point-key)
                     point-key
                     (keyword (key-name point-key)))]
     (when-not (contains? #{:start :end} point-key)
       (problem 400
                "UNSAFE_EVENT_FIELD"
                (str field " contains an unsupported field.")))
     (when-not (map? point)
       (problem 400
                "INVALID_EVENT"
                (str field "." (name point-key) " must be a coordinate map.")))
     (when (> (count point) 2)
       (problem 400
                "INVALID_EVENT"
                (str field "." (name point-key) " has too many entries.")))
     (doseq [[coordinate-key coordinate] point]
       (let [coordinate-key (if (keyword? coordinate-key)
                              coordinate-key
                              (keyword (key-name coordinate-key)))]
         (when-not (contains? #{:line :column} coordinate-key)
           (problem 400
                    "UNSAFE_EVENT_FIELD"
                    (str field "." (name point-key) " contains an unsupported field.")))
         (bounded-number coordinate
                         (str field "." (name point-key) "." (name coordinate-key)))
         (when (neg? coordinate)
           (problem 400
                    "INVALID_EVENT"
                    (str field
                         "."
                         (name point-key)
                         "."
                         (name coordinate-key)
                         " must not be negative.")))))))
  value)

(defn- validate-safe-map
  [value field allowed-fields]
  (when-not (map? value)
    (problem 400 "INVALID_EVENT" (str field " must be a metadata map.")))
  (when (> (count value) 24)
    (problem 400 "INVALID_EVENT" (str field " has too many entries.")))
  (into {}
        (map
         (fn [[key child]]
           (let [key  (if (keyword? key) key (keyword (key-name key)))
                 spec (get safe-field-specs key)]
             (when (contains? sensitive-fields key)
               (problem 400
                        "UNSAFE_EVENT_CONTENT"
                        (str field " contains a content-bearing field.")))
             (when-not (contains? allowed-fields key)
               (problem 400
                        "UNSAFE_EVENT_FIELD"
                        (str field " contains an unsupported field.")))
             (case (first spec)
               :string  (bounded-string child
                                        (str field "." (name key))
                                        (second spec))
               :pattern-string
               (do
                 (bounded-string child
                                 (str field "." (name key))
                                 (second spec))
                 (when-not (re-matches (nth spec 2) child)
                   (problem 400
                            "INVALID_EVENT"
                            (str field "." (name key) " has an unsupported value."))))
               :summary (do
                          (bounded-string child
                                          (str field "." (name key))
                                          (second spec))
                          (when (re-find #"[\p{Cntrl}]" child)
                            (problem 400
                                     "UNSAFE_EVENT_CONTENT"
                                     (str field
                                          "."
                                          (name key)
                                          " contains unsafe characters."))))
               :non-negative-number
               (do
                 (bounded-number child (str field "." (name key)))
                 (when (neg? child)
                   (problem 400
                            "INVALID_EVENT"
                            (str field
                                 "."
                                 (name key)
                                 " must not be negative."))))
               :bounded-integer
               (do
                 (bounded-number child (str field "." (name key)))
                 (when-not (integer? child)
                   (problem 400
                            "INVALID_EVENT"
                            (str field "." (name key) " must be an integer.")))
                 (when (or (< child (second spec)) (> child (nth spec 2)))
                   (problem 400
                            "INVALID_EVENT"
                            (str field "." (name key) " is out of range."))))
               :span (validate-span child (str field "." (name key)))
               :boolean (when-not (boolean? child)
                          (problem
                           400
                           "INVALID_EVENT"
                           (str field "." (name key) " must be boolean."))))
             [key child])))
        value))

(def workspace-fields
  #{:id :name :root :path :file :relativePath :repository :branch :worktree :workspaceId
    :repoId :status :summary})

(def resource-fields
  #{:id :name :path :file :relativePath :ref :kind :nodeId :status :summary :provider
    :action :confidence :durationMs :available :outsideRoot :line :endLine :column
    :endColumn :span :redacted})

(def metadata-fields
  #{:id :name :path :file :ref :kind :status :summary :provider :scope :availability
    :coverage :workspaceId :repoId :durationMs :count :line :column :startLine
    :endLine :endColumn :available :redacted :providerEventType :providerToolCallId
    :providerMessageId :errorClassification :errorCode :unknownEvent
    :contentAvailable :targetAgentId :targetAgentNodeId :targetSessionId
    :targetWorkspaceId :graphNodeId :nodeId
    :permissionResult :permissionKind :exitCode :bytes})

(def source-fields
  #{:client :kind :version})

(defn- validate-depth
  "Iteratively reject deeply nested values before any shape-specific handling."
  [value]
  (loop [pending [[value 0]]]
    (when-let [[current depth] (peek pending)]
      (let [pending (pop pending)]
        (when (and (or (map? current) (vector? current))
                   (> depth max-nesting-depth))
          (problem 400 "INVALID_EVENT" "Event nesting is too deep."))
        (recur (into pending
                     (map #(vector % (inc depth))
                          (cond
                            (map? current)    (concat (keys current)
                                                      (vals current))
                            (vector? current) current
                            :else             []))))))))

(defn- validate-content
  [content]
  (when-not (map? content)
    (problem
     400
     "INVALID_EVENT"
     "content may only be an availability/local-reference metadata map."))
  (when (> (count content) 8)
    (problem 400 "INVALID_EVENT" "content has too many entries."))
  (let [allowed #{:availability :localRef :localReference :mimeType :size
                  :sha256 :redacted}]
    (doseq [[key value] content]
      (let [key (if (keyword? key) key (keyword (key-name key)))]
        (when-not (contains? allowed key)
          (problem 400
                   "INVALID_EVENT"
                   (str "content field " (name key) " is not permitted.")))
        (case key
          :availability (do
                          (bounded-string value "content.availability" 32)
                          (when-not (#{"available" "unavailable" "redacted"}
                                     value)
                            (problem
                             400
                             "INVALID_EVENT"
                             "content.availability has an unsupported value.")))
          :localRef (bounded-string value "content.localRef" 1024)
          :localReference (bounded-string value "content.localReference" 1024)
          :mimeType (bounded-string value "content.mimeType" 128)
          :size (do
                  (bounded-number value "content.size")
                  (when (neg? value)
                    (problem 400
                             "INVALID_EVENT"
                             "content.size must not be negative.")))
          :sha256 (bounded-string value "content.sha256" 128)
          :redacted (when-not (boolean? value)
                      (problem 400
                               "INVALID_EVENT"
                               "content.redacted must be boolean.")))))
    content))

(defn- validate-timestamp
  [value]
  (bounded-string value "timestamp" 64)
  (try
    (if (str/ends-with? value "Z")
      (Instant/parse value)
      (OffsetDateTime/parse value))
    value
    (catch Exception _
      (problem 400
               "INVALID_EVENT"
               "timestamp must be an ISO-8601 date-time with a timezone."))))

(defn- validate-event*
  "Validate and return a normalized event map. This function does not retain
  the event or emit diagnostics containing its content."
  [event]
  (when-not (map? event)
    (problem 400 "INVALID_EVENT" "Event body must be a JSON object."))
  (validate-depth event)
  (let [unknown (seq (remove (into required-fields optional-fields)
                             (keys event)))]
    (when unknown
      (problem 400 "UNSUPPORTED_EVENT_FIELD"
               "Event contains an unsupported field."
               {"fields" (mapv name unknown)})))
  (when-not (= schema-version (:schemaVersion event))
    (problem 400
             "UNSUPPORTED_SCHEMA_VERSION"
             (str "schemaVersion must be " schema-version ".")))
  (doseq [field required-fields]
    (when-not (contains? event field)
      (problem 400
               "INVALID_EVENT"
               (str "Missing required field " (name field) "."))))
  (doseq [[field limit] [[:id 256] [:sessionId 256] [:type 128]]]
    (bounded-string (get event field) (name field) limit))
  (validate-timestamp (:timestamp event))
  (when (contains? event :sequence)
    (when-not (and (integer? (:sequence event)) (not (neg? (:sequence event))))
      (problem 400 "INVALID_EVENT" "sequence must be a non-negative integer.")))
  (doseq [field [:parentId :agentId :turnId :toolCallId :status :tool :snippet
                 :sessionName :agentName]]
    (when (contains? event field)
      (bounded-string (get event field) (name field) 256)))
  (when (contains? event :source)
    (let [source (:source event)]
      (cond
        (string? source) (bounded-string source "source" 256)
        (map? source)    (validate-safe-map source "source" source-fields)
        :else            (problem
                          400
                          "INVALID_EVENT"
                          "source must be a string or source metadata map."))))
  (when (contains? event :workspace)
    (let [workspace (:workspace event)]
      (cond
        (map? workspace) (validate-safe-map workspace
                                            "workspace"
                                            workspace-fields)
        :else            (problem
                          400
                          "INVALID_EVENT"
                          "workspace must be a metadata map."))))
  (when (contains? event :resources)
    (when-not (vector? (:resources event))
      (problem 400 "INVALID_EVENT" "resources must be a list."))
    (when (> (count (:resources event)) 32)
      (problem 400 "INVALID_EVENT" "resources has too many items."))
    (doseq [[index resource] (map-indexed vector (:resources event))]
      (validate-safe-map resource
                         (str "resources[" index "]")
                         resource-fields)))
  (when (contains? event :content)
    (validate-content (:content event)))
  (doseq [field [:metadata :redactedMetadata]]
    (when (contains? event field)
      (when-not (map? (get event field))
        (problem 400
                 "INVALID_EVENT"
                 (str (name field) " must be a metadata map.")))
      (validate-safe-map (get event field) (name field) metadata-fields)))
  event)

(defn validate-event
  "Validate and return a normalized event map. String JSON keys are accepted
  for callers that already decoded JSON without a keyword key function."
  [event]
  (validate-event* (keywordize-top-level event)))

(defn validate-workspace-selector
  "Validate the opaque workspace id used to select an activity stream."
  [workspace-id]
  (when-not (and (string? workspace-id)
                 (re-matches #"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}"
                             workspace-id))
    (problem 400
             "INVALID_WORKSPACE_SELECTOR"
             "workspaceId must be a non-blank opaque workspace identifier."))
  workspace-id)

(defn create-state
  "Create an independent collector. Activity recording is opt-in through
  :activity-capture?/:capture? and uses :activity-log-dir/:log-dir. Live
  replay and archive retention are separate bounded stores."
  ([] (create-state {}))
  ([options]
   (let [replay-limit       (get options :replay-limit max-replay-events)
         client-queue-limit (get options :client-queue-limit max-client-queue)
         max-clients        (get options :max-clients max-clients)
         max-workspaces     (get options :max-workspaces max-workspaces)
         heartbeat-ms       (get options :heartbeat-ms heartbeat-ms)
         origins            (get options :origins default-activity-origins)
         token              (get options :token (new-token))
         capture?           (boolean (if (contains? options :activity-capture?)
                                       (:activity-capture? options)
                                       (if (contains? options :capture?)
                                         (:capture? options)
                                         (:activity-capture options))))
         archive-options    (cond-> {:enabled? capture?
                                     :protected-roots
                                     (or (:activity-protected-roots options)
                                         (:protected-roots options)
                                         [])}
                              (or (contains? options :activity-log-dir)
                                  (contains? options :activity-log-directory)
                                  (contains? options :log-dir))
                              (assoc :directory
                                     (or (:activity-log-dir options)
                                         (:activity-log-directory options)
                                         (:log-dir options)))
                              (contains? options :activity-max-recordings)
                              (assoc :max-recordings
                                     (:activity-max-recordings options))
                              (contains? options :activity-max-events)
                              (assoc :max-events (:activity-max-events options))
                              (contains? options :activity-max-bytes)
                              (assoc :max-bytes (:activity-max-bytes options))
                              (contains? options :activity-max-age-ms)
                              (assoc :max-age-ms (:activity-max-age-ms options))
                              (contains? options :activity-max-age-days)
                              (assoc :max-age-days
                                     (:activity-max-age-days options)))
         archive-state      (or (:activity-archive options)
                                (archive/create-state archive-options))]
   (when-not (and (integer? replay-limit) (pos? replay-limit))
     (throw (IllegalArgumentException. "replay-limit must be positive")))
   (when-not (and (integer? client-queue-limit) (pos? client-queue-limit))
     (throw (IllegalArgumentException. "client-queue-limit must be positive")))
   (when-not (and (integer? max-clients) (pos? max-clients))
     (throw (IllegalArgumentException. "max-clients must be positive")))
   (when-not (and (integer? max-workspaces) (pos? max-workspaces))
     (throw (IllegalArgumentException. "max-workspaces must be positive")))
   (when-not (and (string? token) (not (str/blank? token)))
     (throw (IllegalArgumentException. "token must be a non-blank string")))
   (when-not (coll? origins)
     (throw (IllegalArgumentException. "origins must be a collection")))
   {:lock               (Object.)
    :next-sequence      (atom 0)
    :next-client-id     (atom 0)
    :events             (atom {})
    :workspace-meta     (atom {})
    :workspace-order    (atom [])
    :evicted-workspaces (atom {})
    :eviction-watermark (atom nil)
    :seen               (atom {})
    :clients            (atom {})
    :closed?            (atom false)
    :replay-limit       replay-limit
    :client-queue-limit client-queue-limit
    :max-clients        max-clients
    :max-workspaces     max-workspaces
    :heartbeat-ms       heartbeat-ms
    :origins            (set origins)
    :token              token
    :archive            archive-state
    :archive-errors     (atom 0)})))

(defn- client-closed?*
  [client]
  @(:closed? client))

(defn- close-client-locked!
  [state client]
  (reset! (:closed? client) true)
  (swap! (:clients state) dissoc (:id client))
  true)

(defn- frame-data
  [event]
  (json/write-str event))

(defn event-frame
  "Return the SSE frame for a normalized collected event."
  [event]
  (str "id: "
       (:streamSequence event)
       "\n"
       "event: activity\n"
       "data: "
       (frame-data event)
       "\n\n"))

(defn heartbeat-frame
  []
  ": heartbeat\n\n")

(defn- gap-frame
  [requested oldest]
  (str "event: replay-gap\n"
       "data: "
       (json/write-str {"ok"          false
                        "code"        "REPLAY_GAP"
                        "requestedId" requested
                        "oldestId"    oldest})
       "\n\n"))

(defn- workspace-key
  [event]
  (if-let [workspace-id (or (get-in event [:workspace :id])
                            (get-in event [:workspace :workspaceId]))]
    (validate-workspace-selector workspace-id)
    unknown-workspace))

(defn- workspace-events
  [state workspace]
  (get @(:events state) workspace []))

(defn- workspace-metadata
  [state workspace]
  (get @(:workspace-meta state) workspace {}))

(defn- workspace-active?
  [state workspace]
  (some #(and (not= all-workspaces (:workspace %))
              (= workspace (:workspace %)))
        (vals @(:clients state))))

(defn- evict-workspace-locked!
  [state workspace]
  (let [events (workspace-events state workspace)
        evicted-through (some-> events last :streamSequence)]
    (when evicted-through
      (swap! (:evicted-workspaces state) assoc workspace evicted-through))
    (swap! (:evicted-workspaces state)
      (fn [evicted]
        (if (> (count evicted) (:max-workspaces state))
          (->> evicted
               (sort-by val)
               (drop (- (count evicted) (:max-workspaces state)))
               (into {}))
          evicted)))
    (when evicted-through
      (swap! (:eviction-watermark state)
        (fn [watermark]
          (max (or watermark 0) evicted-through)))))
  (swap! (:events state) dissoc workspace)
  (swap! (:workspace-meta state) dissoc workspace)
  (swap! (:seen state)
    (fn [seen]
      (into {}
            (remove (fn [[_ event]]
                      (= workspace (workspace-key event)))
                    seen))))
  (swap! (:workspace-order state)
    (fn [order]
      (vec (remove #(= workspace %) order))))
  true)

(defn- evicted-through
  [state workspace]
  (or (get @(:evicted-workspaces state) workspace)
      ;; Once an individual eviction tombstone has aged out, retain a
      ;; conservative global signal rather than silently treating a reused
      ;; cursor as a fresh stream.
      @(:eviction-watermark state)))

(defn- ensure-workspace-locked!
  [state workspace]
  (when-not (contains? @(:events state) workspace)
    (when (>= (count @(:workspace-order state))
              (:max-workspaces state))
      (if-let [evictable (some #(when-not (workspace-active? state %)
                                  %)
                               @(:workspace-order state))]
        (evict-workspace-locked! state evictable)
        (problem 503
                 "ACTIVITY_WORKSPACE_CAPACITY"
                 "Activity workspace capacity is full.")))
    (swap! (:events state) assoc workspace [])
    (swap! (:workspace-meta state)
      assoc
      workspace
      {:trimmed-through nil
       :evicted-through (evicted-through state workspace)})
    (swap! (:workspace-order state) conj workspace))
  true)

(defn- parse-last-event-id
  [last-event-id]
  (let [requested (cond
                    (nil? last-event-id) nil
                    (integer? last-event-id) last-event-id
                    (string? last-event-id)
                    (try (Long/parseLong (str/trim last-event-id))
                         (catch Exception _
                           (problem 400
                                    "INVALID_LAST_EVENT_ID"
                                    "Last-Event-ID must be an integer.")))
                    :else (problem 400
                                   "INVALID_LAST_EVENT_ID"
                                   "Last-Event-ID must be an integer."))]
    (when (and requested (neg? requested))
      (problem 400
               "INVALID_LAST_EVENT_ID"
               "Last-Event-ID must be non-negative."))
    requested))

(defn subscribe!
  "Register a bounded client and return {:client client :replay events
  :replay-gap? boolean :oldest-id number-or-nil}. Initial subscribers receive
  the bounded retained history; a Last-Event-ID value resumes strictly after
  that id. A nil selector subscribes to the legacy/unknown workspace bucket."
  ([state] (subscribe! state nil nil))
  ([state last-event-id] (subscribe! state last-event-id nil))
  ([state last-event-id workspace-id]
   (let [requested (parse-last-event-id last-event-id)
         workspace (cond
                     (= workspace-id all-workspaces) all-workspaces
                     workspace-id (validate-workspace-selector workspace-id)
                     :else unknown-workspace)]
     (locking (:lock state)
       (when @(:closed? state)
         (problem 503 "ACTIVITY_STOPPED" "Activity stream is stopped."))
       (when (>= (count @(:clients state)) (:max-clients state))
         (problem 503 "ACTIVITY_CAPACITY" "Activity stream capacity is full."))
       (when-not (= workspace all-workspaces)
         (ensure-workspace-locked! state workspace))
       (let [events (if (= workspace all-workspaces)
                      (->> @(:events state)
                           vals
                           (apply concat)
                           (sort-by :streamSequence)
                           vec)
                      (workspace-events state workspace))
             metadata (when-not (= workspace all-workspaces)
                        (workspace-metadata state workspace))
             oldest (some-> events
                            first
                            :streamSequence)
             gap?   (and requested
                         (or (and metadata (:trimmed-through metadata)
                                  (< requested (:trimmed-through metadata)))
                             (and metadata (:evicted-through metadata)
                                  (< requested (:evicted-through metadata)))))
             client {:id      (swap! (:next-client-id state) inc)
                     :queue     (ArrayBlockingQueue. (:client-queue-limit
                                                      state))
                     :closed?   (atom false)
                     :workspace workspace}
             replay (if requested
                      (filterv #(> (:streamSequence %) requested) events)
                      events)]
         (swap! (:clients state) assoc (:id client) client)
         {:client       client
          :replay       replay
          :replay-gap?  gap?
          :oldest-id    oldest
          :requested-id requested
          :workspace-id (when-not (or (= unknown-workspace workspace)
                                      (= all-workspaces workspace))
                          workspace)})))))

(defn unsubscribe!
  [state client]
  (locking (:lock state)
    (close-client-locked! state client)))

(defn client-queue-size
  [client]
  (.size ^ArrayBlockingQueue (:queue client)))

(defn client-closed?
  [client]
  (client-closed?* client))

(defn poll-client
  "Poll a client queue. This public helper makes queue behavior testable
  without requiring a running HTTP server."
  ([client] (poll-client client 0))
  ([client timeout-ms]
   (.poll ^ArrayBlockingQueue (:queue client)
          (long timeout-ms)
          TimeUnit/MILLISECONDS)))

(defn publish!
  "Validate, sequence, retain, and fan out an event. Duplicate provider ids
  are idempotent while retained in the bounded replay window."
  [state event]
  (let [event (validate-event event)]
    (locking (:lock state)
      (when @(:closed? state)
        (problem 503 "ACTIVITY_STOPPED" "Activity collector is stopped."))
      (let [workspace  (workspace-key event)
            dedupe-key [(or (:source event) "codewalk.local")
                        (:sessionId event)
                        (:id event)]]
        (ensure-workspace-locked! state workspace)
        (if-let [existing (get @(:seen state) dedupe-key)]
          {:status :duplicate
           :stream-sequence (:streamSequence existing)
           :event  existing}
          (let [stream-sequence (swap! (:next-sequence state) inc)
                collected       (assoc event :streamSequence stream-sequence)
                previous-events (workspace-events state workspace)
                all-events      (conj previous-events collected)
                retained        (vec (take-last (:replay-limit state)
                                                all-events))
                trimmed-through (some-> (take (- (count all-events)
                                                 (count retained))
                                             all-events)
                                        last
                                        :streamSequence)
                retained-by-workspace (assoc @(:events state)
                                             workspace
                                             retained)
                retained-keys   (set (for [item (mapcat val
                                                 retained-by-workspace)]
                                       [(or (:source item)
                                            "codewalk.local")
                                        (:sessionId item)
                                        (:id item)]))]
            (reset! (:events state) retained-by-workspace)
            (swap! (:workspace-meta state)
              update
              workspace
              (fn [metadata]
                (cond-> metadata
                  trimmed-through
                  (update :trimmed-through
                          (fn [previous]
                            (max (or previous 0) trimmed-through))))))
            (swap! (:seen state)
              (fn [seen]
                (-> (assoc seen dedupe-key collected)
                    (select-keys retained-keys))))
            (doseq [[_ client] @(:clients state)
                    :when      (or (= workspace (:workspace client))
                                   (= all-workspaces (:workspace client)))]
              (when-not (.offer ^ArrayBlockingQueue (:queue client) collected)
                ;; A slow client is removed rather than allowing it to
                ;; consume publisher or request threads.
                (close-client-locked! state client)))
            ;; The archive receives only the validated provider event.  It
            ;; deliberately does not receive the live stream sequence.
            (try
              (archive/record-event! (:archive state) event)
              (catch Exception _
                ;; Archive I/O must not take down live activity collection.
                ;; The event remains available in the bounded live window.
                (swap! (:archive-errors state) inc)))
            {:status :accepted
             :stream-sequence stream-sequence
             :event  collected}))))))

(defn snapshot
  [state]
  (locking (:lock state)
    {:events       (vec (mapcat val @(:events state)))
     :events-by-workspace @(:events state)
     :client-count (count @(:clients state))
     :closed?      @(:closed? state)}))

(defn stop!
  "Close all clients and prevent further collection."
  [state]
  (locking (:lock state)
    (reset! (:closed? state) true)
    (doseq [[_ client] @(:clients state)]
      (reset! (:closed? client) true))
    (reset! (:clients state) {})
    (archive/stop! (:archive state))
    true))

(defn activity-token
  "Return the process-local token for wiring a trusted producer/viewer. This
  value is never included in an event, response, or log."
  [state]
  (:token state))

(defn- request-origin
  [^HttpExchange exchange]
  (.getFirst (.getRequestHeaders exchange) "Origin"))

(defn- request-token
  [^HttpExchange exchange]
  (.getFirst (.getRequestHeaders exchange) "X-Codewalk-Activity-Token"))

(defn- request-query-param
  [^HttpExchange exchange key]
  (some (fn [part]
          (let [[name value] (str/split part #"=" 2)]
            (when (and (= key name) value)
              (try
                (URLDecoder/decode value "UTF-8")
                (catch IllegalArgumentException _
                  (problem 400
                           "INVALID_WORKSPACE_SELECTOR"
                           "workspaceId must be URL encoded."))))))
        (str/split (or (.getRawQuery (.getRequestURI exchange)) "") #"&")))

(defn- trusted-origin?
  [state origin]
  (or (nil? origin)
      (contains? (:origins state) origin)))

(defn- same-token?
  [expected actual]
  (and (string? actual)
       (MessageDigest/isEqual
        (.getBytes ^String expected StandardCharsets/UTF_8)
        (.getBytes ^String actual StandardCharsets/UTF_8))))

(defn- authorize!
  [^HttpExchange exchange state]
  (let [origin (request-origin exchange)]
    (when-not (trusted-origin? state origin)
      (problem 403 "ORIGIN_NOT_ALLOWED" "Browser origin is not allowed."))
    (when-not (same-token? (:token state) (request-token exchange))
      (problem 401
               "INVALID_ACTIVITY_TOKEN"
               "Activity token is missing or invalid."))
    origin))

(defn- authorize-origin!
  [^HttpExchange exchange state]
  (let [origin (request-origin exchange)]
    (when-not (trusted-origin? state origin)
      (problem 403 "ORIGIN_NOT_ALLOWED" "Browser origin is not allowed."))
    origin))

(defn- set-cors!
  [^HttpExchange exchange state]
  (let [headers (.getResponseHeaders exchange)
        origin  (request-origin exchange)]
    (when (and origin (contains? (:origins state) origin))
      (.set headers "Access-Control-Allow-Origin" origin)
      (.set headers "Vary" "Origin"))
    (.set headers "Access-Control-Allow-Methods" "GET, POST, OPTIONS")
    (.set headers
          "Access-Control-Allow-Headers"
          "Content-Type, Last-Event-ID, X-Codewalk-Activity-Token")))

(defn- send-json!
  [^HttpExchange exchange state status value]
  (let [body (.getBytes (json/write-str value) StandardCharsets/UTF_8)]
    (set-cors! exchange state)
    (.set (.getResponseHeaders exchange)
          "Content-Type"
          "application/json; charset=utf-8")
    (.sendResponseHeaders exchange status (alength body))
    (with-open [output (.getResponseBody exchange)]
      (.write output body))))

(defn- send-error!
  [^HttpExchange exchange state error]
  (let [data (ex-data error)]
    (send-json! exchange
                state
                (or (:status data) 500)
                {"ok"    false
                 "error" {"code"    (or (:code data) "INTERNAL_ERROR")
                          "message" (.getMessage error)}})))

(defn handle-request!
  "Handle an activity endpoint with origin/token authorization and structured
  failures. OPTIONS is origin-checked but does not require the token so a
  browser can preflight a request carrying the token header."
  [^HttpExchange exchange state route]
  (try
    (if (= "OPTIONS" (.getRequestMethod exchange))
      (do
        (authorize-origin! exchange state)
        (set-cors! exchange state)
        (.sendResponseHeaders exchange 204 -1)
        (.close (.getResponseBody exchange)))
      (do
        (authorize! exchange state)
        (route exchange)))
    (catch clojure.lang.ExceptionInfo error
      (try
        (send-error! exchange state error)
        (catch IOException _ nil)))
    (catch Exception _
      (try
        (send-json! exchange
                    state
                    500
                    {"ok"    false
                     "error" {"code"    "INTERNAL_ERROR"
                              "message" "Unable to handle activity request."}})
        (catch IOException _ nil)))))

(defn http-handler
  "Create a handler for one activity endpoint. It intentionally does not use
  the general server handler because that handler has legacy wildcard CORS."
  [state route]
  (reify
   com.sun.net.httpserver.HttpHandler
     (handle [_ exchange]
       (handle-request! exchange state route))))

(defn- read-limited!
  [^InputStream input]
  (let [buffer (byte-array 8192)
        output (java.io.ByteArrayOutputStream.)]
    (loop [total 0]
      (let [read (.read input buffer)]
        (cond
          (neg? read) (.toString output "UTF-8")
          (zero? read) (recur total)
          (> (+ total read) max-body-bytes)
          (problem 413
                   "BODY_TOO_LARGE"
                   (str "Request body exceeds " max-body-bytes " bytes."))
          :else
          (do (.write output buffer 0 read)
              (recur (+ total read))))))))

(defn- content-type
  [^HttpExchange exchange]
  (some-> (.getFirst (.getRequestHeaders exchange) "Content-Type")
          (str/split #";" 2)
          first
          str/trim
          str/lower-case))

(defn- collect-route!
  [^HttpExchange exchange state]
  (when-not (= "application/json" (content-type exchange))
    (problem 415
             "UNSUPPORTED_MEDIA_TYPE"
             "Activity events require Content-Type: application/json."))
  (let [body   (read-limited! (.getRequestBody exchange))
        event  (try
                 (json/read-str body :key-fn keyword)
                 (catch StackOverflowError _
                   (problem 400
                            "INVALID_EVENT"
                            "Event nesting is too deep."))
                 (catch Exception _
                   (problem 400
                            "MALFORMED_JSON"
                            "Request body is not valid JSON.")))
        result (publish! state event)]
    ;; Do not return the event body. The producer already has its own copy
    ;; and response bodies must not become an accidental content sink.
    (send-json! exchange
                state
                (if (= :duplicate (:status result)) 200 202)
                {"ok"        true
                 "duplicate" (= :duplicate (:status result))
                 "streamSequence" (:stream-sequence result)})))

(defn events-route
  "Route implementation for /api/activity/events."
  [^HttpExchange exchange state]
  (authorize! exchange state)
  (if (= "POST" (.getRequestMethod exchange))
    (collect-route! exchange state)
    (send-json! exchange
                state
                405
                {"ok"    false
                 "error" {"code"    "METHOD_NOT_ALLOWED"
                          "message" "Only POST is supported."}})))

(declare stream!)

(defn stream-route
  "Route implementation for /api/activity/stream."
  [^HttpExchange exchange state streaming-executor]
  (authorize! exchange state)
  (if (= "GET" (.getRequestMethod exchange))
    (do
      ;; Validate synchronously so malformed reconnect cursors receive a
      ;; structured HTTP error rather than an asynchronous connection
      ;; close.
      (parse-last-event-id
       (.getFirst (.getRequestHeaders exchange) "Last-Event-ID"))
      (let [workspace-id (request-query-param exchange "workspaceId")
            all-workspaces? (= "true" (request-query-param exchange "allWorkspaces"))
            selected-workspace (if all-workspaces? all-workspaces workspace-id)]
        (when (and all-workspaces? workspace-id)
          (problem 400
                   "INVALID_WORKSPACE_SELECTOR"
                   "Choose either workspaceId or allWorkspaces."))
        (when-not all-workspaces?
          (validate-workspace-selector workspace-id))
        (try
          (.execute streaming-executor #(stream! exchange state selected-workspace))
          (catch RejectedExecutionException _
            (send-json! exchange
                        state
                        503
                        {"ok"    false
                         "error" {"code" "ACTIVITY_CAPACITY"
                                  "message"
                                  "Activity stream capacity is full."}})))))
    (send-json! exchange
                state
                405
                {"ok"    false
                 "error" {"code"    "METHOD_NOT_ALLOWED"
                          "message" "Only GET is supported."}})))

(defn stream!
  "Serve one SSE connection. The caller should run this on a streaming
  executor, not the normal fixed request executor."
  ([^HttpExchange exchange state]
   (stream! exchange state (request-query-param exchange "workspaceId")))
  ([^HttpExchange exchange state workspace-id]
   (let [client*       (atom nil)
         headers-sent? (atom false)]
     (try
       (let [last-id (.getFirst (.getRequestHeaders exchange) "Last-Event-ID")
             {:keys [client replay replay-gap? oldest-id requested-id]}
              (subscribe! state last-id workspace-id)]
         (reset! client* client)
         (set-cors! exchange state)
         (let [headers (.getResponseHeaders exchange)]
           (.set headers "Content-Type" "text/event-stream; charset=utf-8")
           (.set headers "Cache-Control" "no-cache, no-store")
           (.set headers "Connection" "keep-alive")
           (.sendResponseHeaders exchange 200 0)
           (reset! headers-sent? true))
         (with-open [output (.getResponseBody exchange)]
           (when replay-gap?
             (.write output
                     (.getBytes (gap-frame requested-id oldest-id)
                                StandardCharsets/UTF_8))
             (.flush output))
           (doseq [event replay]
             (.write output
                     (.getBytes (event-frame event) StandardCharsets/UTF_8)))
           (.flush output)
           (loop []
             (when-not (and (client-closed?* client)
                            (zero? (client-queue-size client)))
               (if-let [event (poll-client client (:heartbeat-ms state))]
                 (do (.write output
                             (.getBytes (event-frame event)
                                        StandardCharsets/UTF_8))
                     (.flush output)
                     (recur))
                 (do (.write output
                             (.getBytes (heartbeat-frame)
                                        StandardCharsets/UTF_8))
                     (.flush output)
                     (recur)))))))
       (catch IOException _ nil)
       (catch clojure.lang.ExceptionInfo error
         (when-not @headers-sent?
           (send-json! exchange
                       state
                       (or (:status (ex-data error)) 500)
                       {"ok"    false
                        "error" {"code"    (or (:code (ex-data error))
                                               "INTERNAL_ERROR")
                                 "message" (.getMessage error)}})))
       (catch Exception _
         (when-not @headers-sent?
           (send-json! exchange
                       state
                       500
                       {"ok"    false
                        "error" {"code"    "INTERNAL_ERROR"
                                 "message"
                                 "Unable to open activity stream."}})))
       (finally
        (when-let [client @client*]
           (unsubscribe! state client)))))))

(defn- recording-path-parts
  [^HttpExchange exchange]
  (let [path   (.getPath (.getRequestURI exchange))
        prefix "/api/activity/recordings"]
    (cond
      (= path prefix) []
      (str/starts-with? path (str prefix "/"))
      (let [suffix (subs path (inc (count prefix)))]
        (mapv (fn [part]
                (when (str/blank? part)
                  (problem 400
                           "INVALID_RECORDING_ID"
                           "Recording path contains an empty segment."))
                (try
                  (URLDecoder/decode part "UTF-8")
                  (catch IllegalArgumentException _
                    (problem 400
                             "INVALID_RECORDING_ID"
                             "recordingId must be URL encoded."))))
              (str/split suffix #"/" -1)))
      :else nil)))

(defn recordings-route
  "Authenticated read-only archive API. Archive rows are never published to
  live SSE subscribers."
  [^HttpExchange exchange state]
  (if-not (= "GET" (.getRequestMethod exchange))
    (send-json! exchange
                state
                405
                {"ok"    false
                 "error" {"code"    "METHOD_NOT_ALLOWED"
                          "message" "Only GET is supported."}})
    (let [parts (recording-path-parts exchange)
          archive-state (:archive state)]
      (cond
        (nil? parts)
        (send-json! exchange
                    state
                    404
                    {"ok"    false
                     "error" {"code"    "NOT_FOUND"
                              "message" "Unknown activity recording endpoint."}})

        (empty? parts)
        (let [result (archive/list-recordings
                      archive-state
                      {:workspace-id (request-query-param exchange "workspaceId")
                       :session-id   (request-query-param exchange "sessionId")
                       :limit        (request-query-param exchange "limit")
                       :cursor       (request-query-param exchange "cursor")})]
          (send-json! exchange
                      state
                      200
                      (merge {"ok" true} result)))

        (= 1 (count parts))
        (let [manifest (archive/get-recording archive-state (first parts))]
          (when-not manifest
            (problem 404
                     "RECORDING_NOT_FOUND"
                     "Recording was not found."))
          (send-json! exchange
                      state
                      200
                      {"ok"       true
                       "recording" manifest
                       "manifest"  manifest}))

        (and (= 2 (count parts))
             (= "events" (second parts)))
        (let [result (archive/recording-events
                      archive-state
                      (first parts)
                      {:after (request-query-param exchange "after")
                       :limit (request-query-param exchange "limit")})]
          (send-json! exchange
                      state
                      200
                      (merge {"ok"       true
                              "recording" (:recording result)
                              "manifest"  (:recording result)}
                             (dissoc result :recording))))

        :else
        (send-json! exchange
                    state
                    404
                    {"ok"    false
                     "error" {"code"    "NOT_FOUND"
                              "message" "Unknown activity recording endpoint."}})))))

(defn activity-route
  "Route implementation used by codewalk.server. GET is handed to the
  supplied streaming executor so it never occupies the normal request pool."
  [^HttpExchange exchange state streaming-executor]
  (let [path (some-> (.getRequestURI exchange)
                     .getPath)]
    (cond
      (= path "/api/activity/events")
      (events-route exchange state)

      (= path "/api/activity/stream")
      (stream-route exchange state streaming-executor)

      (or (= path "/api/activity/recordings")
          (str/starts-with? path "/api/activity/recordings/"))
      (recordings-route exchange state)

      :else
      (send-json! exchange
                  state
                  404
                  {"ok"    false
                   "error" {"code"    "NOT_FOUND"
                            "message" "Unknown activity endpoint."}}))))
