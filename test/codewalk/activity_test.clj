(ns codewalk.activity-test
  (:require
   [clojure.data.json :as json]
   [clojure.java.io :as io]
   [clojure.test :refer [deftest is testing]]
   [codewalk.activity :as activity]
   [codewalk.server :as server])
  (:import
   [java.net URI]
   [java.net.http HttpClient HttpRequest HttpRequest$BodyPublishers
    HttpResponse$BodyHandlers]
   [java.util.concurrent TimeUnit]))

(defn- event
  ([id] (event id {}))
  ([id extra]
   (merge {:schemaVersion 1
           :id            id
           :sessionId     "session-1"
           :timestamp     "2026-08-26T20:00:00Z"
           :type          "tool.started"}
          extra)))

(defn- error-code
  [f]
  (try
    (f)
    nil
    (catch clojure.lang.ExceptionInfo error
      (:code (ex-data error)))))

(deftest validation-rejects-malformed-and-unsafe-events
  (testing "required fields, version, and timestamp"
    (is (= "INVALID_EVENT"
           (error-code #(activity/validate-event (dissoc (event "a") :id)))))
    (is (= "UNSUPPORTED_SCHEMA_VERSION"
           (error-code #(activity/validate-event
                         (assoc (event "a") :schemaVersion 2)))))
    (is (= "INVALID_EVENT"
           (error-code #(activity/validate-event
                         (assoc (event "a") :timestamp "soon"))))))
  (testing "unknown fields and raw content"
    (is (= "UNSUPPORTED_EVENT_FIELD"
           (error-code #(activity/validate-event
                         (assoc (event "a") :secret "raw")))))
    (is (= "INVALID_EVENT"
           (error-code #(activity/validate-event (assoc (event "a")
                                                        :content
                                                        "prompt text"))))))
  (testing "bounded values"
    (is (= "INVALID_EVENT"
           (error-code #(activity/validate-event
                         (assoc (event "a")
                                :metadata
                                (into {}
                                      (map (fn [n] [(keyword (str "key-" n))
                                                    true])
                                           (range 33))))))))
    (is (= "INVALID_EVENT"
           (error-code #(activity/validate-event
                         (assoc (event "a") :resources (vec (range 33)))))))))

(deftest duplicate-events-are-idempotent-and-stream-sequence-is-monotonic
  (let [state        (activity/create-state {:replay-limit 4})
        first-result (activity/publish! state (event "same"))
        duplicate    (activity/publish! state (event "same"))
        second       (activity/publish! state (event "next"))]
    (is (= :accepted (:status first-result)))
    (is (= :duplicate (:status duplicate)))
    (is (= 1 (:stream-sequence duplicate)))
    (is (= 2 (:stream-sequence second)))
    (is (= [1 2] (mapv :streamSequence (:events (activity/snapshot state)))))))

(deftest deduplication-is-scoped-to-source-and-session
  (let [state         (activity/create-state)
        same-session  (event "same")
        other-session (assoc same-session :sessionId "session-2")
        other-source  (assoc same-session :source "other-provider")]
    (is (= :accepted (:status (activity/publish! state same-session))))
    (is (= :duplicate (:status (activity/publish! state same-session))))
    (is (= :accepted (:status (activity/publish! state other-session))))
    (is (= :accepted (:status (activity/publish! state other-source))))
    (is (= [1 2 3]
           (mapv :streamSequence (:events (activity/snapshot state)))))))

(deftest redaction-allows-only-explicit-safe-shapes
  (doseq [[field value] [[:metadata {:prompt "do not retain"}]
                         [:redactedMetadata {:arguments "secret"}]
                         [:workspace {:command "cat secret"}]
                         [:resources ["raw command output"]]
                         [:resources [{:output "secret"}]]]]
    (is (contains? #{"INVALID_EVENT" "UNSAFE_EVENT_CONTENT"
                     "UNSAFE_EVENT_FIELD"}
                   (error-code #(activity/validate-event
                                 (assoc (event "unsafe") field value))))))
  (is (map? (activity/validate-event
             (assoc (event "safe")
                    :workspace {:path   "src/codewalk"
                                :root   "/Users/example/worktree"
                                :branch "main"}
                    :resources [{:path    "src/a.clj"
                                 :kind    "file"
                                 :status  "read"
                                 :summary "bounded"}]
                    :metadata  {:summary "bounded"
                                :status  "ok"})))))

(deftest named-sessions-and-agents-are-accepted
  (testing "the producer sets sessionName/agentName on every named session"
    (let [validated (activity/validate-event
                     (assoc (event "named-session")
                            :type "session"
                            :status "started"
                            :sessionName "Wave 0 conformance"
                            :agentName "Luna implementer"))]
      (is (= "Wave 0 conformance" (:sessionName validated)))
      (is (= "Luna implementer" (:agentName validated)))))
  (testing "both names stay bounded"
    (doseq [field [:sessionName :agentName]]
      (is (= "INVALID_EVENT"
             (error-code #(activity/validate-event
                           (assoc (event "oversized-name")
                                  field
                                  (apply str (repeat 257 "x")))))))
      (is (= "INVALID_EVENT"
             (error-code #(activity/validate-event
                           (assoc (event "non-string-name") field 7))))))))

(deftest explicit-graph-node-metadata-is-accepted
  (testing "the resolver's explicit-target fields survive validation"
    (let [metadata  {:graphNodeId "namespace:app" :nodeId "var:app/run"}
          validated (activity/validate-event
                     (assoc (event "explicit-target") :metadata metadata))]
      (is (= metadata (:metadata validated)))))
  (testing "both stay bounded"
    (doseq [field [:graphNodeId :nodeId]]
      (is (= "INVALID_EVENT"
             (error-code #(activity/validate-event
                           (assoc (event "oversized-node")
                                  :metadata
                                  {field (apply str (repeat 257 "x"))}))))))))

(deftest producer-snippets-and-workspace-roots-are-accepted
  (is (map? (activity/validate-event
             (assoc (event "safe-snippet")
                    :snippet "view · src/codewalk/activity.clj"
                    :workspace {:root "/Users/example/worktree"
                               :repository "codewalk"})))))

(deftest producer-agent-target-metadata-conforms-to-collector
  (let [metadata {:targetAgentId "target-agent"
                  :targetAgentNodeId "agent:%5B%22workspace%22%5D"
                  :targetSessionId "target-session"
                  :targetWorkspaceId "local-target-1234"}
        validated (activity/validate-event
                   (assoc (event "agent-target")
                          :type "tool.started"
                          :tool "read_agent"
                          :metadata metadata))]
    (is (= metadata (:metadata validated)))
    (is (= "INVALID_EVENT"
           (error-code #(activity/validate-event
                         (assoc (event "oversized-agent-target")
                               :metadata
                               (assoc metadata
                                      :targetAgentId (apply str (repeat 257 "x"))))))))))

(deftest permission-and-outcome-metadata-conforms-to-collector
  (testing "permissionKind, permissionResult, exitCode, and bytes are all accepted"
    (let [metadata  {:permissionKind   "shell"
                     :permissionResult "denied-interactively-by-user"
                     :exitCode         -1
                     :bytes            2048}
          validated (activity/validate-event
                     (assoc (event "permission-and-outcome") :metadata metadata))]
      (is (= metadata (:metadata validated)))))
  (testing "an out-of-pattern permissionResult is rejected"
    (is (= "INVALID_EVENT"
           (error-code #(activity/validate-event
                         (assoc (event "bad-permission-result")
                                :metadata {:permissionResult "Not Valid!"}))))))
  (testing "an out-of-pattern permissionKind is rejected"
    (is (= "INVALID_EVENT"
           (error-code #(activity/validate-event
                         (assoc (event "bad-permission-kind")
                                :metadata {:permissionKind "UPPERCASE"}))))))
  (testing "exitCode must be an integer within +/-2^31"
    (is (= "INVALID_EVENT"
           (error-code #(activity/validate-event
                         (assoc (event "non-integer-exit-code")
                                :metadata {:exitCode 1.5})))))
    (is (= "INVALID_EVENT"
           (error-code #(activity/validate-event
                         (assoc (event "out-of-range-exit-code")
                                :metadata {:exitCode 99999999999}))))))
  (testing "bytes must not be negative"
    (is (= "INVALID_EVENT"
           (error-code #(activity/validate-event
                         (assoc (event "negative-bytes")
                                :metadata {:bytes -1})))))))

(defn- json-files
  "Fixture files directly in `directory`. Deliberately not recursive: the
  hand-authored corpus and the generated corpus are asserted separately."
  [directory]
  (->> (.listFiles (io/file directory))
       (filter #(and (.isFile %)
                     (.endsWith (.getName %) ".json")))
       (sort-by #(.getName %))))

(defn- producer-envelope-fixtures
  []
  (mapv #(json/read-str (slurp %) :key-fn keyword)
        (json-files "test/fixtures/activity")))

(deftest producer-envelope-fixtures-conform-to-collector
  (let [fixtures (producer-envelope-fixtures)
        validated (mapv activity/validate-event fixtures)]
    (is (= 6 (count fixtures)))
    (is (= #{"tool" "session"}
           (set (map :type validated))))
    (doseq [fixture validated]
      (testing (:id fixture)
        (is (map? fixture))
        (is (= 1 (:schemaVersion fixture)))))
    (let [named (->> validated
                     (filter #(= "fixture-session-start" (:id %)))
                     first)]
      (is (= "Wave 0 conformance" (:sessionName named)))
      (is (= "Luna implementer" (:agentName named))))
    (let [span-resource (->> validated
                             (mapcat #(or (:resources %) []))
                             (filter :span)
                             first)]
      (is (= "src/span.clj" (:file span-resource)))
      (is (= 10 (:line span-resource)))
      (is (= 12 (:endLine span-resource)))
      (is (= 2 (:column span-resource)))
      (is (= 8 (:endColumn span-resource)))
      (is (= "node-1" (:nodeId span-resource)))
      (is (= 10 (get-in span-resource [:span :start :line])))
      (is (= 8 (get-in span-resource [:span :end :column])))))
  (let [locations (activity/validate-event
                   (assoc (event "location-fields")
                          :workspace {:file "src/workspace.clj"}
                          :resources [{:file "src/resource.clj"
                                       :line 3
                                       :endLine 5
                                       :column 1
                                       :endColumn 9
                                       :nodeId "node-2"
                                       :span {:start {:line 3 :column 1}
                                              :end {:line 5 :column 9}}}]
                          :metadata {:file "src/metadata.clj"
                                     :path "src/metadata.clj"
                                     :line 3
                                     :endLine 5
                                     :column 1
                                     :endColumn 9}))]
    (is (= "src/workspace.clj" (get-in locations [:workspace :file])))
    (is (= "src/metadata.clj" (get-in locations [:metadata :file])))
    (is (= "src/metadata.clj" (get-in locations [:metadata :path])))))

(deftest generated-envelopes-conform-to-collector
  (let [files (json-files "test/fixtures/activity/generated")]
    (is (seq files)
        (str "no generated envelopes found in test/fixtures/activity/generated; "
             "run `npm run fixtures`"))
    (doseq [file files]
      (let [envelope (json/read-str (slurp file) :key-fn keyword)
            outcome  (try
                       {:accepted (activity/validate-event envelope)}
                       (catch clojure.lang.ExceptionInfo error
                         {:rejected (assoc (ex-data error)
                                           :message
                                           (ex-message error))}))]
        (is (:accepted outcome)
            (str (.getName file)
                 " was rejected by the collector: "
                 (pr-str (select-keys (:rejected outcome)
                                      [:code :status :details :message]))))
        (when-let [accepted (:accepted outcome)]
          (is (= 1 (:schemaVersion accepted))
              (.getName file)))))))

(deftest development-viewer-origin-is-allowed-by-default
  (is (contains? activity/default-activity-origins
                 "http://127.0.0.1:4173")))

(deftest nesting-is-bounded-without-recursive-normalization
  (let [deep (reduce (fn [value _] [value]) "leaf" (range 20))]
    (is (= "INVALID_EVENT"
           (error-code #(activity/validate-event
                         (assoc (event "deep") :metadata deep)))))))

(deftest replay-and-explicit-replay-gap
  (let [state (activity/create-state {:replay-limit 2})]
    (doseq [id ["one" "two" "three"]]
      (activity/publish! state (event id)))
    (let [initial (activity/subscribe! state)
          {:keys [replay replay-gap? oldest-id]} (activity/subscribe! state "0")
          current (activity/subscribe! state "2")]
      (is (= [2 3] (mapv :streamSequence (:replay initial))))
      (is replay-gap?)
      (is (= 2 oldest-id))
      (is (= [2 3] (mapv :streamSequence replay)))
      (is (not (:replay-gap? current)))
      (is (= [3] (mapv :streamSequence (:replay current))))
      (activity/unsubscribe! state (:client initial))
      (activity/unsubscribe! state (:client current)))))

(deftest workspace-streams-isolate-replay-live-events-and-retention
  (let [state       (activity/create-state {:replay-limit 2})
        workspace-a "local-a-aaaaaaaa"
        workspace-b "local-b-bbbbbbbb"
        publish     (fn [id workspace]
                      (activity/publish! state
                                         (event id
                                                {:workspace {:id workspace}})))]
    (publish "a-1" workspace-a)
    (publish "b-1" workspace-b)
    (publish "b-2" workspace-b)
    (publish "b-3" workspace-b)
    (publish "a-2" workspace-a)
    (let [{a-client :client a-replay :replay a-gap? :replay-gap?}
          (activity/subscribe! state "1" workspace-a)
          {b-client :client b-replay :replay}
          (activity/subscribe! state nil workspace-b)]
      (try
        (is (not a-gap?)
            "traffic in another workspace does not create a replay gap")
        (is (= ["a-2"] (mapv :id a-replay)))
        (is (= ["b-2" "b-3"] (mapv :id b-replay)))
        (publish "a-3" workspace-a)
        (publish "b-4" workspace-b)
        (is (= "a-3" (:id (activity/poll-client a-client 100))))
        (is (= "b-4" (:id (activity/poll-client b-client 100))))
        (let [{a-replay-client :client a-replay-events :replay}
              (activity/subscribe! state nil workspace-a)]
          (try
            (is (= ["a-2" "a-3"] (mapv :id a-replay-events)))
            (finally
             (activity/unsubscribe! state a-replay-client))))
        (publish "a-4" workspace-a)
        (let [{a-gap-client :client a-gap? :replay-gap? a-oldest :oldest-id}
              (activity/subscribe! state "1" workspace-a)]
          (try
            (is a-gap?)
            (is (= 6 a-oldest))
            (finally
             (activity/unsubscribe! state a-gap-client))))
        (finally
         (activity/unsubscribe! state a-client)
         (activity/unsubscribe! state b-client))))))

(deftest all-workspace-stream-replays-and-follows-project-switches
  (let [state (activity/create-state)
        publish (fn [id workspace]
                 (activity/publish! state
                                    (event id {:workspace {:id workspace}})))]
    (publish "a-1" "local-a-aaaaaaaa")
    (publish "b-1" "local-b-bbbbbbbb")
    (let [{client :client replay :replay}
         (activity/subscribe! state nil activity/all-workspaces)]
      (try
        (is (= ["a-1" "b-1"] (mapv :id replay)))
        (publish "b-2" "local-b-bbbbbbbb")
        (is (= "b-2" (:id (activity/poll-client client 100))))
        (finally
         (activity/unsubscribe! state client))))))

(deftest workspace-selector-validation
  (let [state (activity/create-state)]
    (is (= "INVALID_WORKSPACE_SELECTOR"
           (error-code #(activity/subscribe! state nil ""))))
    (is (= "INVALID_WORKSPACE_SELECTOR"
           (error-code #(activity/subscribe! state nil "../other"))))
    (is (= "local-1-abcdef12"
           (activity/validate-workspace-selector "local-1-abcdef12")))
    (is (thrown? IllegalArgumentException
                 (activity/create-state {:max-workspaces 0})))
    (is (thrown? IllegalArgumentException
                 (activity/create-state {:max-workspaces "2"})))))

(deftest workspace-buckets-evict-deterministically-with-monotonic-reentry
  (let [state   (activity/create-state {:max-workspaces 2})
        publish (fn [id workspace]
                  (activity/publish! state
                                     (event id {:workspace {:id workspace}})))]
    (publish "a-1" "local-a-aaaaaaaa")
    (publish "b-1" "local-b-bbbbbbbb")
    (publish "c-1" "local-c-cccccccc")
    (is (= #{"local-b-bbbbbbbb" "local-c-cccccccc"}
           (set (keys (:events-by-workspace (activity/snapshot state))))))
    (is (= ["local-b-bbbbbbbb" "local-c-cccccccc"]
           @(:workspace-order state)))
    (is (= 3 @(:next-sequence state)))
    (let [reentry (publish "a-1" "local-a-aaaaaaaa")
          next-event (publish "a-2" "local-a-aaaaaaaa")]
      (is (= :accepted (:status reentry)))
      (is (= 4 (:stream-sequence reentry)))
      (is (= 5 (:stream-sequence next-event))))
    (is (= #{"local-a-aaaaaaaa" "local-c-cccccccc"}
           (set (keys (:events-by-workspace (activity/snapshot state))))))
    (is (= ["local-c-cccccccc" "local-a-aaaaaaaa"]
           @(:workspace-order state)))
    (is (= ["a-1" "a-2"]
           (mapv :id
                 (get (:events-by-workspace (activity/snapshot state))
                      "local-a-aaaaaaaa"))))
    (is (= [4 5]
           (mapv :streamSequence
                 (get (:events-by-workspace (activity/snapshot state))
                      "local-a-aaaaaaaa"))))))

(deftest old-cursor-replays-new-event-after-workspace-eviction-and-reentry
  (let [state   (activity/create-state {:max-workspaces 1
                                        :replay-limit  2})
        publish (fn [id workspace]
                  (activity/publish! state
                                     (event id {:workspace {:id workspace}})))
        a1 (publish "a-1" "local-a-aaaaaaaa")
        b1 (publish "b-1" "local-b-bbbbbbbb")
        reentry (publish "a-2" "local-a-aaaaaaaa")
        {:keys [client replay replay-gap? oldest-id]}
        (activity/subscribe! state "1" "local-a-aaaaaaaa")]
    (try
      (is (= [1 2 3]
             (mapv :stream-sequence [a1 b1 reentry])))
      (is (= 3 (:stream-sequence reentry)))
      (is (= [3] (mapv :streamSequence replay)))
      (is replay-gap?)
      (is (= 3 oldest-id))
      (is (not (contains? (set (map :id replay)) "a-1")))
      (finally
       (activity/unsubscribe! state client)))))

(deftest active-workspaces-are-protected-from-eviction
  (let [state   (activity/create-state {:max-workspaces 2})
        publish (fn [id workspace]
                  (activity/publish! state
                                     (event id {:workspace {:id workspace}})))]
    (publish "a-1" "local-a-aaaaaaaa")
    (publish "b-1" "local-b-bbbbbbbb")
    (let [client (:client (activity/subscribe! state nil "local-a-aaaaaaaa"))]
      (try
        (publish "c-1" "local-c-cccccccc")
        (is (= #{"local-a-aaaaaaaa" "local-c-cccccccc"}
               (set (keys (:events-by-workspace
                           (activity/snapshot state))))))
        (is (= "local-a-aaaaaaaa" (:workspace client)))
        (publish "a-2" "local-a-aaaaaaaa")
        (is (= 4 (:streamSequence (activity/poll-client client 100))))
        (finally
         (activity/unsubscribe! state client))))))

(deftest workspace-capacity-fails-when-all-buckets-are-active
  (let [state    (activity/create-state {:max-workspaces 2})
        client-a (:client (activity/subscribe! state nil "local-a-aaaaaaaa"))
        client-b (:client (activity/subscribe! state nil "local-b-bbbbbbbb"))]
    (try
      (is (= "ACTIVITY_WORKSPACE_CAPACITY"
             (error-code #(activity/publish!
                           state
                           (event "c-1"
                                  {:workspace {:id "local-c-cccccccc"}})))))
      (is (= #{"local-a-aaaaaaaa" "local-b-bbbbbbbb"}
             (set (keys (:events-by-workspace (activity/snapshot state))))))
      (finally
       (activity/unsubscribe! state client-a)
       (activity/unsubscribe! state client-b)))))

(deftest queue-bounds-slow-client-and-cleanup
  (let [state  (activity/create-state {:client-queue-limit 2})
        client (:client (activity/subscribe! state))]
    (doseq [id ["a" "b" "c"]]
      (activity/publish! state (event id)))
    (is (activity/client-closed? client))
    (is (zero? (:client-count (activity/snapshot state))))
    (activity/stop! state)
    (is (:closed? (activity/snapshot state)))))

(deftest sse-frames-and-concurrent-publishers
  (let [state  (activity/create-state {:client-queue-limit 32})
        client (:client (activity/subscribe! state))]
    (try
      (->> (range 20)
           (map #(future (activity/publish! state (event (str "event-" %)))))
           (mapv #(deref % 5 ::timeout))
           (run! #(is (not= ::timeout %))))
      (let [events (repeatedly 20 #(activity/poll-client client 1000))]
        (is (= (range 1 21) (sort (map :streamSequence events)))))
      (is (= ": heartbeat\n\n" (activity/heartbeat-frame)))
      (is (re-find #"^id: 1\nevent: activity\ndata: .*streamSequence"
                   (activity/event-frame {:streamSequence 1 :id "x"})))
      (finally
       (activity/unsubscribe! state client)))))

(defn- http-request
  [client uri method body content-type origin token]
  (let [base-builder    (HttpRequest/newBuilder (URI/create uri))
        method-builder  (case method
                          :post (.POST base-builder
                                       (HttpRequest$BodyPublishers/ofString
                                        body))
                          :get  (.GET base-builder)
                          :put  (.method base-builder
                                         "PUT"
                                         (HttpRequest$BodyPublishers/ofString
                                          body)))
        content-builder (.header method-builder "Content-Type" content-type)
        origin-builder  (if origin
                          (.header content-builder "Origin" origin)
                          content-builder)
        token-builder   (if token
                          (.header origin-builder
                                   "X-Codewalk-Activity-Token"
                                   token)
                          origin-builder)]
    (.send client
           (.build token-builder)
           (HttpResponse$BodyHandlers/ofString))))

(deftest http-route-methods-content-type-and-body-limits
  (let [http     (HttpClient/newHttpClient)
        token    "test-activity-token"
        origin   "http://viewer.test"
        instance (server/start! {:port 0
                                 :activity-token token
                                 :activity-origins #{origin}})
        port     (.getPort (.getAddress instance))
        uri      (str "http://127.0.0.1:"
                      port
                      "/api/activity/events")]
    (try
      (let [valid        (json/write-str (event "http-valid"))
            accepted
            (http-request http uri :post valid "application/json" origin token)
            missing-type
            (http-request http uri :post valid "text/plain" origin token)
            malformed
            (http-request http uri :post "{" "application/json" origin token)
            oversized    (http-request
                          http
                          uri
                          :post
                          (apply str (repeat (inc activity/max-body-bytes) "x"))
                          "application/json"
                          origin
                          token)
            put-result
            (http-request http uri :put "" "application/json" origin token)]
        (is (= 202 (.statusCode accepted)))
        (is (= 415 (.statusCode missing-type)))
        (is (= 400 (.statusCode malformed)))
        (is (= 413 (.statusCode oversized)))
        (is (= 405 (.statusCode put-result))))
      (finally
       (server/stop! instance)))))

(deftest activity-origin-and-token-authorization
  (let [http     (HttpClient/newHttpClient)
        token    "correct-token"
        origin   "http://trusted.test"
        instance (server/start! {:port 0
                                 :activity-token token
                                 :activity-origins #{origin}})
        port     (.getPort (.getAddress instance))
        events   (str "http://127.0.0.1:" port "/api/activity/events")
        stream   (str "http://127.0.0.1:"
                      port
                      "/api/activity/stream?workspaceId=local-1-abcdef12")]
    (try
      (let [body           (json/write-str (event "security"))
            denied-origin    (http-request http
                                           events
                                           :post
                                           body
                                           "application/json"
                                           "http://evil.test"
                                           token)
            missing-token    (http-request http
                                           events
                                           :post
                                           body
                                           "application/json"
                                           origin
                                           nil)
            wrong-token      (http-request http
                                           events
                                           :post
                                           body
                                           "application/json"
                                           origin
                                           "wrong")
            accepted         (http-request http
                                           events
                                           :post
                                           body
                                           "application/json"
                                           origin
                                           token)
            missing-stream   (http-request http
                                           stream
                                           :get
                                           ""
                                           "text/event-stream"
                                           origin
                                           nil)
            wrong-stream     (http-request http
                                           stream
                                           :get
                                           ""
                                           "text/event-stream"
                                           origin
                                           "wrong")
            invalid-selector (http-request
                              http
                              (str "http://127.0.0.1:"
                                   port
                                   "/api/activity/stream?workspaceId=../other")
                              :get
                              ""
                              "text/event-stream"
                              origin
                              token)
            stream-request (HttpRequest/newBuilder
                              (URI/create stream))
            stream-request (.header stream-request "Origin" origin)
            stream-request   (.header stream-request
                                      "X-Codewalk-Activity-Token"
                                      token)
            stream-future    (.sendAsync
                              http
                              (.build (.GET stream-request))
                                      (HttpResponse$BodyHandlers/ofInputStream))
            stream-response (.get stream-future 5 TimeUnit/SECONDS)]
        (is (= 403 (.statusCode denied-origin)))
        (is (= 401 (.statusCode missing-token)))
        (is (= 401 (.statusCode wrong-token)))
        (is (= 202 (.statusCode accepted)))
        (is (= 401 (.statusCode missing-stream)))
        (is (= 401 (.statusCode wrong-stream)))
        (is (= 400 (.statusCode invalid-selector)))
        (is (= 200 (.statusCode stream-response)))
        (is (= origin
               (first (.allValues (.headers stream-response)
                                  "Access-Control-Allow-Origin"))))
        (.close (.body stream-response)))
      (finally
       (server/stop! instance)))))

(deftest saturated-stream-executor-returns-structured-503
  (let [http     (HttpClient/newHttpClient)
        token    "capacity-token"
        origin   "http://viewer.test"
        instance (server/start! {:port 0
                                 :activity-token token
                                 :activity-origins #{origin}
                                 :activity-stream-threads 1
                                 :activity-stream-queue-limit 1})
        port     (.getPort (.getAddress instance))
        stream   (str "http://127.0.0.1:"
                      port
                      "/api/activity/stream?workspaceId=local-1-abcdef12")
        request  (fn []
                   (-> (HttpRequest/newBuilder (URI/create stream))
                       (.header "Origin" origin)
                       (.header "X-Codewalk-Activity-Token" token)
                       (.GET)
                       (.build)))]
    (try
      (let [first-response (.get (.sendAsync
                                  http
                                  (request)
                                  (HttpResponse$BodyHandlers/ofInputStream))
                                 5
                                 TimeUnit/SECONDS)
            second         (.sendAsync
                            http
                            (request)
                            (HttpResponse$BodyHandlers/ofInputStream))
            third          (.sendAsync
                            http
                            (request)
                            (HttpResponse$BodyHandlers/ofInputStream))
            saturated      (.get
                            (java.util.concurrent.CompletableFuture/anyOf
                             (into-array
                              java.util.concurrent.CompletableFuture
                              [second third]))
                            5
                            TimeUnit/SECONDS)]
        (is (= 200 (.statusCode first-response)))
        (is (= 503 (.statusCode saturated)))
        (with-open [body (.body saturated)]
          (is (= "ACTIVITY_CAPACITY"
                 (get-in (json/read-str (slurp body) :key-fn keyword)
                         [:error :code]))))
        (.close (.body first-response))
        (doseq [future [second third]
                :let   [response (try
                                   (.get future 5 TimeUnit/SECONDS)
                                   (catch Exception _ nil))]
                :when  (and response (not (identical? response saturated)))]
          (.close (.body response))))
      (finally
       (server/stop! instance)))))
