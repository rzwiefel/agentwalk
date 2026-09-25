(ns codewalk.activity-archive
  "Dependency-free, metadata-only activity recording storage.

  The archive is intentionally separate from the live activity replay window.
  It stores validated producer events in per-session JSONL recordings and
  exposes bounded read helpers used by the authenticated activity routes."
  (:require
   [clojure.data.json :as json]
   [clojure.java.io :as io]
   [clojure.string :as str])
  (:import
   [java.nio.charset StandardCharsets]
   [java.nio.file CopyOption Files OpenOption Path StandardCopyOption
    StandardOpenOption]
   [java.nio.file.attribute FileAttribute PosixFilePermissions]
   [java.time Instant]
   [java.util UUID]))

(def format-version 1)
(def schema-version 1)
(def redaction-policy "activity-metadata-v1")

(def default-max-recordings 20)
(def default-max-events 100000)
(def default-max-bytes (* 100 1024 1024))
(def default-max-age-ms (* 14 24 60 60 1000))

(def default-list-limit 50)
(def max-list-limit 100)
(def default-event-limit 100)
(def max-event-limit 1000)
(def max-cursor 1000000)
(def max-recording-id-length 128)

(defn default-log-directory
  []
  (io/file (System/getProperty "user.home")
           ".codewalk"
           "runtime"
           "activity-log"))

(defn- api-problem
  [status code message]
  (throw (ex-info message
                  {:status    status
                   :api-error true
                   :code      code})))

(defn- positive-integer!
  [value field]
  (when-not (and (integer? value) (pos? value))
    (throw (IllegalArgumentException.
            (str field " must be a positive integer"))))
  value)

(defn- non-negative-integer!
  [value field]
  (when-not (and (integer? value) (not (neg? value)))
    (throw (IllegalArgumentException.
            (str field " must be a non-negative integer"))))
  value)

(defn- canonical-file
  [value]
  (.getCanonicalFile (io/file value)))

(defn- path-inside?
  [parent child]
  (let [parent-path (.getCanonicalPath (canonical-file parent))
        child-path  (.getCanonicalPath (canonical-file child))
        prefix      (str parent-path java.io.File/separator)]
    (or (= parent-path child-path)
        (str/starts-with? child-path prefix))))

(defn- assert-outside-protected-roots!
  [directory protected-roots]
  (when-let [root (some #(when (and (string? %)
                                    (not (str/blank? %))
                                    (path-inside? % directory))
                          %)
                        protected-roots)]
    (throw (IllegalArgumentException.
            (str "Activity archive directory must not be inside an analyzed "
                 "repository: " root))))
  directory)

(defn- set-directory-permissions!
  [^java.io.File directory]
  (try
    (Files/setPosixFilePermissions
     (.toPath directory)
     (PosixFilePermissions/fromString "rwx------"))
    (catch UnsupportedOperationException _
      nil))
  directory)

(defn- set-file-permissions!
  [^java.io.File file]
  (try
    (Files/setPosixFilePermissions
     (.toPath file)
     (PosixFilePermissions/fromString "rw-------"))
    (catch UnsupportedOperationException _
      nil))
  file)

(defn- ensure-directory!
  [^java.io.File directory]
  (Files/createDirectories (.toPath directory) (make-array FileAttribute 0))
  (set-directory-permissions! directory))

(defn- write-bytes!
  [^java.io.File file bytes]
  (let [parent (.getParentFile file)]
    (when parent
      (ensure-directory! parent))
    (Files/write (.toPath file)
                 ^bytes bytes
                 (into-array OpenOption
                             [StandardOpenOption/CREATE
                              StandardOpenOption/TRUNCATE_EXISTING
                              StandardOpenOption/WRITE]))
    (set-file-permissions! file)
    file))

(defn- append-bytes!
  [^java.io.File file bytes]
  (let [parent (.getParentFile file)]
    (when parent
      (ensure-directory! parent))
    (Files/write (.toPath file)
                 ^bytes bytes
                 (into-array OpenOption
                             [StandardOpenOption/CREATE
                              StandardOpenOption/APPEND
                              StandardOpenOption/WRITE]))
    (set-file-permissions! file)
    file))

(defn- json-bytes
  [value]
  (.getBytes (json/write-str value) StandardCharsets/UTF_8))

(defn- atomic-move!
  [^Path source ^Path target]
  (try
    (Files/move source
                target
                (into-array CopyOption
                            [StandardCopyOption/ATOMIC_MOVE
                             StandardCopyOption/REPLACE_EXISTING]))
    (catch java.nio.file.AtomicMoveNotSupportedException _
      (Files/move source
                  target
                  (into-array CopyOption
                              [StandardCopyOption/REPLACE_EXISTING])))))

(defn- write-json-file!
  [^java.io.File file value]
  (let [parent (.getParentFile file)
        _      (when parent (ensure-directory! parent))
        tmp    (Files/createTempFile
                (.toPath (or parent (io/file ".")))
                (str "." (.getName file) "-")
                ".tmp"
                (make-array FileAttribute 0))]
    (try
      (write-bytes! (.toFile tmp) (json-bytes value))
      (atomic-move! tmp (.toPath file))
      (set-file-permissions! file)
      file
      (finally
        (Files/deleteIfExists tmp)))))

(defn- read-json-file
  [^java.io.File file]
  (when (.isFile file)
    (json/read-str (slurp file :encoding "UTF-8") :key-fn keyword)))

(defn- parse-instant
  [value]
  (try
    (when (string? value)
      (Instant/parse value))
    (catch Exception _
      nil)))

(defn- valid-recording-id?
  [value]
  (and (string? value)
       (<= 1 (count value) max-recording-id-length)
       (boolean (re-matches #"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}"
                            value))))

(defn validate-recording-id
  [value]
  (when-not (valid-recording-id? value)
    (api-problem 400
                 "INVALID_RECORDING_ID"
                 "recordingId must be a bounded opaque identifier."))
  value)

(defn validate-session-selector
  [value]
  (when-not (and (string? value)
                 (<= 1 (count value) 256)
                 (not (re-find #"[\p{Cntrl}]" value))
                 (not (str/blank? value)))
    (api-problem 400
                 "INVALID_SESSION_SELECTOR"
                 "sessionId must be a bounded non-blank identifier."))
  value)

(defn validate-workspace-selector
  [value]
  (when-not (and (string? value)
                 (re-matches #"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}"
                             value))
    (api-problem 400
                 "INVALID_WORKSPACE_SELECTOR"
                 "workspaceId must be a bounded opaque workspace identifier."))
  value)

(defn- parse-bounded-long
  [value field default maximum code]
  (let [parsed (cond
                 (nil? value) default
                 (integer? value) (long value)
                 (string? value)
                 (try
                   (Long/parseLong (str/trim value))
                   (catch Exception _
                     (api-problem 400 code
                                  (str field " must be an integer."))))
                 :else
                 (api-problem 400 code
                              (str field " must be an integer.")))]
    (when (or (neg? parsed) (> parsed maximum))
      (api-problem 400
                   code
                   (str field " is outside its allowed range.")))
    parsed))

(defn parse-list-limit
  [value]
  (let [limit (parse-bounded-long value
                                  "limit"
                                  default-list-limit
                                  max-list-limit
                                  "INVALID_LIMIT")]
    (when (zero? limit)
      (api-problem 400 "INVALID_LIMIT" "limit must be positive."))
    (int limit)))

(defn parse-event-limit
  [value]
  (let [limit (parse-bounded-long value
                                  "limit"
                                  default-event-limit
                                  max-event-limit
                                  "INVALID_LIMIT")]
    (when (zero? limit)
      (api-problem 400 "INVALID_LIMIT" "limit must be positive."))
    (int limit)))

(defn parse-cursor
  [value]
  (parse-bounded-long value
                      "cursor"
                      0
                      max-cursor
                      "INVALID_CURSOR"))

(defn parse-after
  [value]
  (parse-bounded-long value
                      "after"
                      0
                      default-max-events
                      "INVALID_AFTER"))

(defn- source-id
  [event]
  (let [source (:source event)]
    (cond
      (string? source) source
      (map? source) (str/join "|"
                              [(or (:client source) "")
                               (or (:kind source) "")
                               (or (:version source) "")
                               (or (:provider source) "")])
      :else "codewalk.local")))

(defn- source-summary
  [event]
  (let [source (:source event)]
    (cond
      (string? source) {:provider source}
      (map? source) (select-keys source [:client :kind :version])
      :else {:provider "codewalk.local"})))

(defn- session-summary
  [event]
  (cond-> {:sessionId (:sessionId event)
           :source    (source-id event)}
    (:sessionName event) (assoc :sessionName (:sessionName event))
    (:agentId event) (assoc :agentId (:agentId event))
    (:agentName event) (assoc :agentName (:agentName event))
    (seq (source-summary event))
    (assoc :sourceSummary (source-summary event))))

(defn- workspace-summary
  [event]
  (when (map? (:workspace event))
    (let [workspace (:workspace event)]
      (cond-> (select-keys workspace
                           [:id :name :root :path :repository :branch
                            :worktree :workspaceId :repoId :summary])
        (:id workspace) (assoc :workspaceId (:id workspace))))))

(defn- recording-key
  [event]
  [(or (get-in event [:workspace :id])
       (get-in event [:workspace :workspaceId]))
   (:sessionId event)
   (source-id event)])

(defn- new-manifest
  [recording-id captured-at event]
  {:formatVersion          format-version
   :schemaVersion          schema-version
   :recordingId            recording-id
   :status                 "active"
   :createdAt              captured-at
   :closedAt               nil
   :eventCount             0
   :byteCount              0
   :firstProviderTimestamp nil
   :lastProviderTimestamp  nil
   :firstRecordingSequence nil
   :lastRecordingSequence  nil
   :sessionSummary         (session-summary event)
   :workspaceSummary       (workspace-summary event)
   :redactionPolicy        redaction-policy})

(defn- manifest-summary
  [manifest]
  (let [status          (:status manifest)
        complete?       (= "complete" status)
        partial?        (= "partial" status)
        session         (cond-> (or (:sessionSummary manifest) {})
                          (:createdAt manifest) (assoc :startedAt (:createdAt manifest))
                          (:closedAt manifest) (assoc :endedAt (:closedAt manifest))
                          true (assoc :eventCount (or (:eventCount manifest) 0)
                                      :complete complete?))
        workspace       (:workspaceSummary manifest)
        summary         (select-keys manifest
                                     [:formatVersion :schemaVersion :recordingId
                                      :status :createdAt :closedAt :eventCount
                                      :byteCount :firstProviderTimestamp
                                      :lastProviderTimestamp
                                      :firstRecordingSequence
                                      :lastRecordingSequence :sessionSummary
                                      :workspaceSummary :redactionPolicy])]
    (cond-> (assoc summary
                   :sessions [session]
                   :workspaces (if workspace [workspace] [])
                   :complete complete?
                   :partial partial?)
      (:sessionId session) (assoc :sessionId (:sessionId session))
      (:sessionName session) (assoc :sessionName (:sessionName session))
      (:agentName session) (assoc :agentName (:agentName session))
      (:workspaceId workspace) (assoc :workspaceId (:workspaceId workspace))
      workspace (assoc :workspace workspace)
      (:createdAt manifest) (assoc :startedAt (:createdAt manifest))
      (:closedAt manifest) (assoc :endedAt (:closedAt manifest)))))

(defn- event-row
  [recording-sequence captured-at event]
  {:recordingSequence recording-sequence
   :capturedAt        captured-at
   :event             (dissoc event :streamSequence)})

(defn- valid-row?
  [row expected-sequence]
  (and (map? row)
       (= expected-sequence (:recordingSequence row))
       (string? (:capturedAt row))
       (map? (:event row))))

(defn- split-jsonl
  "Return valid parsed rows and whether a malformed/truncated tail was found.
  The final valid row is normalized to a newline so future appends cannot
  accidentally join a recovered partial line."
  [^java.io.File events-file]
  (if-not (.isFile events-file)
    {:rows [] :partial? false :bytes 0}
    (let [text (String. (Files/readAllBytes (.toPath events-file))
                        StandardCharsets/UTF_8)
          lines (str/split text #"\n" -1)]
      (loop [remaining lines
             rows []
             expected-sequence 1
             partial? false]
        (if (empty? remaining)
          (let [normalized (if (seq rows)
                             (str (str/join "\n" (map :raw rows)) "\n")
                             "")
                bytes (.getBytes normalized StandardCharsets/UTF_8)]
            (when (or partial?
                      (not= text normalized))
              (write-bytes! events-file bytes))
            {:rows  (mapv :value rows)
             :partial? partial?
             :bytes (alength bytes)})
          (let [line (first remaining)
                tail? (empty? (rest remaining))
                line (str/replace line #"\r$" "")]
            (if (and tail? (str/blank? line))
              (recur [] rows expected-sequence partial?)
              (let [parsed (try
                             {:value (json/read-str line :key-fn keyword)}
                             (catch Exception _
                               {:error true}))
                    value  (:value parsed)]
                (if (and (not (:error parsed))
                         (valid-row? value expected-sequence))
                  (recur (rest remaining)
                         (conj rows {:raw line :value value})
                         (inc expected-sequence)
                         partial?)
                  (recur [] rows expected-sequence true))))))))))

(defn- repaired-manifest
  [manifest rows partial?]
  (let [first-row (first rows)
        last-row (last rows)
        first-event (:event first-row)
        last-event (:event last-row)
        was-active? (= "active" (:status manifest))
        status (if (or partial? was-active? (= "partial" (:status manifest)))
                 "partial"
                 "complete")]
    (cond-> (assoc manifest
                   :formatVersion format-version
                   :schemaVersion schema-version
                   :status status
                   :closedAt (when (not= "active" status)
                               (or (:closedAt manifest) (str (Instant/now))))
                   :eventCount (count rows)
                   :byteCount nil
                   :firstProviderTimestamp (some-> first-event :timestamp)
                   :lastProviderTimestamp (some-> last-event :timestamp)
                   :firstRecordingSequence (some-> first-row :recordingSequence)
                   :lastRecordingSequence (some-> last-row :recordingSequence)
                   :redactionPolicy redaction-policy)
      (nil? (:sessionSummary manifest))
      (assoc :sessionSummary {})
      (nil? (:workspaceSummary manifest))
      (assoc :workspaceSummary nil))))

(defn- delete-tree!
  [^java.io.File directory]
  (doseq [file (sort-by #(.length (.getPath ^java.io.File %)) > (file-seq directory))]
    (Files/deleteIfExists (.toPath ^java.io.File file)))
  true)

(defn- recording-directory
  [state recording-id]
  (io/file (:directory state) recording-id))

(defn- recording-files
  [state recording-id]
  (let [directory (recording-directory state recording-id)]
    {:directory directory
     :manifest  (io/file directory "manifest.json")
     :events    (io/file directory "events.jsonl")}))

(defn- persist-index!
  [state]
  (write-json-file!
   (io/file (:directory state) "index.json")
   {:formatVersion format-version
    :schemaVersion schema-version
    :updatedAt (str (Instant/now))
    :recordings (->> @(:recordings state)
                     vals
                     (map (comp manifest-summary deref :manifest))
                     (sort-by (juxt :createdAt :recordingId))
                     vec)}))

(defn- persist-recording!
  [state recording]
  (let [{:keys [manifest]} (recording-files state (:id recording))]
    (write-json-file! manifest @(:manifest recording))
    (persist-index! state))
  true)

(defn- read-recording!
  [state directory]
  (let [recording-id (.getName ^java.io.File directory)
        {:keys [manifest events]} (recording-files state recording-id)]
    (when (and (valid-recording-id? recording-id)
               (.isFile manifest))
      (try
        (let [loaded (read-json-file manifest)
              loaded (assoc loaded :recordingId recording-id)
              {:keys [rows partial? bytes]} (split-jsonl events)
              manifest-value (assoc (repaired-manifest loaded rows partial?)
                                    :byteCount bytes)
              changed? (or partial?
                           (not= (:eventCount loaded) (:eventCount manifest-value))
                           (not= (:byteCount loaded) (:byteCount manifest-value))
                           (= "active" (:status loaded)))]
          (when changed?
            (write-json-file! manifest manifest-value))
          {:id       recording-id
           :directory directory
           :key      [(get-in manifest-value [:workspaceSummary :workspaceId])
                      (get-in manifest-value [:sessionSummary :sessionId])
                      (get-in manifest-value [:sessionSummary :source])]
           :manifest (atom manifest-value)
           :active?  false})
        (catch Exception _
          nil)))))

(defn- load-recordings!
  [state]
  (let [directory (:directory state)]
    (when (.isDirectory directory)
      (doseq [child (sort-by #(.getName ^java.io.File %)
                             (filter #(.isDirectory ^java.io.File %)
                                     (file-seq directory)))]
        (when (= (.getParentFile child) directory)
          (when-let [recording (read-recording! state child)]
            (swap! (:recordings state) assoc (:id recording) recording))))
      (persist-index! state)))
  true)

(defn- sorted-recordings
  [state]
  (sort-by (fn [recording]
             [(or (:createdAt @(:manifest recording)) "")
              (:id recording)])
           (vals @(:recordings state))))

(defn- active-recording?
  [recording]
  (:active? recording))

(defn- remove-recording-locked!
  [state recording]
  (when-not (active-recording? recording)
    (delete-tree! (:directory recording))
    (swap! (:recordings state) dissoc (:id recording))
    (swap! (:active state)
           (fn [active]
             (into {}
                   (remove (fn [[_ recording-id]]
                             (= (:id recording) recording-id))
                           active))))
    true))

(defn- evict-aged-locked!
  [state]
  (let [cutoff (.minusMillis (Instant/now) (long (:max-age-ms state)))]
    (doseq [recording (sorted-recordings state)
            :let [created (parse-instant (:createdAt @(:manifest recording)))]
            :when (and created
                       (.isBefore created cutoff)
                       (not (active-recording? recording)))]
      (remove-recording-locked! state recording)))
  (persist-index! state)
  true)

(defn- archive-totals
  [state]
  (reduce (fn [{:keys [events bytes] :as totals} recording]
            (let [manifest @(:manifest recording)]
              {:events (+ events (long (or (:eventCount manifest) 0)))
               :bytes  (+ bytes (long (or (:byteCount manifest) 0)))}))
          {:events 0 :bytes 0}
          (vals @(:recordings state))))

(defn- evict-for-capacity-locked!
  [state projected-recordings projected-events projected-bytes current]
  (loop [recordings-count projected-recordings
         events-count projected-events
         bytes-count projected-bytes]
    (if (and (<= recordings-count (:max-recordings state))
             (<= events-count (:max-events state))
             (<= bytes-count (:max-bytes state)))
      true
      (if-let [candidate (first (filter (fn [recording]
                                          (and (not (active-recording? recording))
                                               (not= current recording)))
                                        (sorted-recordings state)))]
        (let [manifest @(:manifest candidate)]
          (remove-recording-locked! state candidate)
          (recur (dec recordings-count)
                 (- events-count (long (or (:eventCount manifest) 0)))
                 (- bytes-count (long (or (:byteCount manifest) 0)))))
        false))))

(defn- create-recording-locked!
  [state captured-at event key]
  (let [totals (archive-totals state)]
    (when (evict-for-capacity-locked!
           state
           (inc (count @(:recordings state)))
           (:events totals)
           (:bytes totals)
           nil)
      (let [recording-id (str (UUID/randomUUID))
            directory (recording-directory state recording-id)
            {:keys [manifest events]} (recording-files state recording-id)
            recording {:id        recording-id
                       :directory directory
                       :key       key
                       :manifest  (atom (new-manifest recording-id
                                                      captured-at
                                                      event))
                       :active?   true}]
        (ensure-directory! directory)
        (write-bytes! events (byte-array 0))
        (write-json-file! manifest @(:manifest recording))
        (swap! (:recordings state) assoc recording-id recording)
        (swap! (:active state) assoc key recording-id)
        (persist-index! state)
        recording))))

(defn- close-recording-locked!
  [state recording status]
  (when (active-recording? recording)
    (swap! (:manifest recording)
           (fn [manifest]
             (assoc manifest
                    :status status
                    :closedAt (str (Instant/now)))))
    (assoc recording :active? false)
    ;; The record stored in :recordings is immutable, so update it as well.
    (swap! (:recordings state) assoc (:id recording) (assoc recording :active? false))
    (swap! (:active state)
           (fn [active]
             (into {}
                   (remove (fn [[_ recording-id]]
                             (= (:id recording) recording-id))
                           active))))
    (persist-recording! state (assoc recording :active? false))
    true))

(defn- event-terminal?
  [event]
  (let [type   (:type event)
        status (some-> (:status event) str/lower-case)]
    (or (= "session.ended" type)
        (and (= "session" type)
             (#{"ended" "complete" "completed" "stopped"} status)))))

(defn- archive-safe-for-event?
  [state event]
  (let [workspace-root (or (get-in event [:workspace :root])
                           (get-in event [:workspace :path]))]
    (not (and workspace-root
              (path-inside? workspace-root (:directory state))))))

(defn record-event!
  "Append one already-validated event to its active per-session recording.
  This function deliberately does not assign or persist live streamSequence."
  [state event]
  (when (and state (:enabled? state) (not @(:closed? state)))
    (locking (:lock state)
      (when (archive-safe-for-event? state event)
        (evict-aged-locked! state)
        (let [key          (recording-key event)
              recording-id (get @(:active state) key)
              recording    (or (get @(:recordings state) recording-id)
                               (create-recording-locked!
                                state
                                (str (Instant/now))
                                event
                                key))]
          (when recording
            (let [captured-at (str (Instant/now))
                  sequence    (inc (long (or (:lastRecordingSequence
                                             @(:manifest recording))
                                            0)))
                  row         (event-row sequence captured-at event)
                  bytes       (.getBytes (str (json/write-str row) "\n")
                                         StandardCharsets/UTF_8)
                  totals      (archive-totals state)
                  manifest    @(:manifest recording)
                  projected-events (+ (:events totals) 1)
                  projected-bytes (+ (:bytes totals) (alength bytes))
                  fits? (evict-for-capacity-locked!
                         state
                         (count @(:recordings state))
                         projected-events
                         projected-bytes
                         recording)]
              (if-not fits?
                (do
                  (close-recording-locked! state recording "partial")
                  {:status :partial :recording-id (:id recording)})
                (let [{:keys [events]} (recording-files state (:id recording))
                      _ (append-bytes! events bytes)
                      updated (assoc manifest
                                    :eventCount (inc (long (or (:eventCount manifest)
                                                               0)))
                                    :byteCount (+ (long (or (:byteCount manifest) 0))
                                                  (alength bytes))
                                    :firstProviderTimestamp
                                    (or (:firstProviderTimestamp manifest)
                                        (:timestamp event))
                                    :lastProviderTimestamp (:timestamp event)
                                    :firstRecordingSequence
                                    (or (:firstRecordingSequence manifest)
                                        sequence)
                                    :lastRecordingSequence sequence)]
                  (reset! (:manifest recording) updated)
                  (persist-recording! state recording)
                  (when (event-terminal? event)
                    (close-recording-locked! state recording "complete"))
                  {:status :accepted
                   :recording-id (:id recording)
                   :recording-sequence sequence})))))))))

(defn close-all!
  "Close active recordings as partial during process shutdown. A provider
  session.ended event is the only event that marks a recording complete."
  ([state] (close-all! state "partial"))
  ([state status]
   (when state
     (locking (:lock state)
       (doseq [recording (vals @(:recordings state))
               :when (active-recording? recording)]
         (close-recording-locked! state recording status))))
   true))

(defn stop!
  [state]
  (when state
    (close-all! state "partial")
    (reset! (:closed? state) true))
  true)

(defn- matches-filter?
  [manifest workspace-id session-id]
  (and (or (nil? workspace-id)
           (= workspace-id
              (get-in manifest [:workspaceSummary :workspaceId])))
       (or (nil? session-id)
           (= session-id (get-in manifest [:sessionSummary :sessionId])))))

(defn list-recordings
  "Return bounded newest-first recording summaries and a decimal offset
  cursor. The returned page is a snapshot under the archive lock."
  [state {:keys [workspace-id session-id limit cursor]}]
  (let [limit (parse-list-limit limit)
        cursor (parse-cursor cursor)]
    (when workspace-id (validate-workspace-selector workspace-id))
    (when session-id (validate-session-selector session-id))
    (if-not state
      {:recordings [] :nextCursor nil :total 0}
      (locking (:lock state)
        (let [recordings (->> (vals @(:recordings state))
                               (map (comp manifest-summary deref :manifest))
                               (filter #(matches-filter? %
                                                         workspace-id
                                                         session-id))
                               (sort-by (juxt :createdAt :recordingId)
                                        #(compare %2 %1))
                               vec)
              page-end  (min (count recordings) (+ cursor limit))
              page      (if (>= cursor (count recordings))
                          []
                          (subvec recordings cursor page-end))
              next-cursor (when (< page-end (count recordings))
                            (str page-end))]
          {:recordings page
           :nextCursor next-cursor
           :total (count recordings)})))))

(defn get-recording
  [state recording-id]
  (validate-recording-id recording-id)
  (when state
    (locking (:lock state)
      (some-> (get @(:recordings state) recording-id)
              :manifest
              deref
              manifest-summary))))

(defn- read-rows
  [^java.io.File events-file snapshot-sequence after limit]
  (if-not (.isFile events-file)
    {:events [] :next-after nil}
    (let [text (String. (Files/readAllBytes (.toPath events-file))
                        StandardCharsets/UTF_8)]
      (loop [remaining (str/split text #"\n" -1)
             events []
             next-after nil]
        (if (empty? remaining)
          {:events events
           :next-after next-after}
          (let [line (first remaining)]
            (if (str/blank? line)
              (recur (rest remaining) events next-after)
              (let [parsed (try
                             {:row (json/read-str line :key-fn keyword)}
                             (catch Exception _
                               {:error true}))
                    row    (:row parsed)
                    sequence (:recordingSequence row)]
                (cond
                  (:error parsed)
                  {:events events :next-after next-after}

                  (or (not (integer? sequence))
                      (> sequence snapshot-sequence))
                  {:events events :next-after next-after}

                  (> sequence after)
                  (if (< (count events) limit)
                    (recur (rest remaining)
                           (conj events row)
                           next-after)
                    {:events events
                     :next-after (:recordingSequence (last events))})

                  :else
                  (recur (rest remaining) events next-after))))))))))

(defn recording-events
  "Read one bounded page. The lastRecordingSequence is captured before the
  file is scanned, so an active recording cannot grow into the page while it
  is being read."
  [state recording-id {:keys [after limit]}]
  (validate-recording-id recording-id)
  (let [after (parse-after after)
        limit (parse-event-limit limit)]
    (when-not state
      (api-problem 404 "RECORDING_NOT_FOUND" "Recording was not found."))
    (locking (:lock state)
      (let [recording (get @(:recordings state) recording-id)]
        (when-not recording
          (api-problem 404 "RECORDING_NOT_FOUND" "Recording was not found."))
        (let [manifest @(:manifest recording)
              snapshot-sequence (long (or (:lastRecordingSequence manifest) 0))
              {:keys [events next-after]}
              (read-rows (:events (recording-files state recording-id))
                         snapshot-sequence
                         after
                         limit)]
          {:recording (manifest-summary manifest)
           :snapshotSequence snapshot-sequence
           :events events
           :nextAfter (some-> next-after str)
           :nextCursor (some-> next-after str)
           :complete (= "complete" (:status manifest))
           :partial (= "partial" (:status manifest))})))))

(defn create-state
  "Create archive state. Capture is disabled by default; an existing archive
  may still be read when capture is false. Supported aliases include
  :directory/:log-dir, :capture?/:enabled?, and :protected-roots."
  ([] (create-state {}))
  ([options]
   (let [directory (canonical-file
                    (or (:directory options)
                        (:log-dir options)
                        (default-log-directory)))
         enabled? (boolean (if (contains? options :enabled?)
                             (:enabled? options)
                             (if (contains? options :capture?)
                               (:capture? options)
                               false)))
         protected-roots (vec (remove str/blank?
                                      (map str
                                           (or (:protected-roots options)
                                               []))))
         max-recordings (or (:max-recordings options)
                            (:activity-max-recordings options)
                            default-max-recordings)
         max-events (or (:max-events options)
                        (:activity-max-events options)
                        default-max-events)
         max-bytes (or (:max-bytes options)
                       (:activity-max-bytes options)
                       default-max-bytes)
         max-age-ms (or (:max-age-ms options)
                        (:activity-max-age-ms options)
                        (when-let [days (:max-age-days options)]
                          (* (long days) 24 60 60 1000))
                        default-max-age-ms)]
     (positive-integer! max-recordings "max-recordings")
     (positive-integer! max-events "max-events")
     (positive-integer! max-bytes "max-bytes")
     (non-negative-integer! max-age-ms "max-age-ms")
     (assert-outside-protected-roots! directory protected-roots)
     (let [state {:lock           (Object.)
                  :directory      directory
                  :enabled?       enabled?
                  :max-recordings max-recordings
                  :max-events     max-events
                  :max-bytes      max-bytes
                  :max-age-ms     max-age-ms
                  :recordings     (atom {})
                  :active         (atom {})
                  :closed?        (atom false)}]
       (when (or enabled? (.isDirectory directory))
         (when enabled?
           (ensure-directory! directory))
         (load-recordings! state)
         (when enabled?
           (locking (:lock state)
             (evict-aged-locked! state)
             (let [{:keys [events bytes]} (archive-totals state)]
               (evict-for-capacity-locked!
                state
                (count @(:recordings state))
                events
                bytes
                nil)
               (persist-index! state)))))
       state))))
