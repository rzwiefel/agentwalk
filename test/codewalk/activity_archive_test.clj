(ns codewalk.activity-archive-test
  (:require
   [clojure.data.json :as json]
   [clojure.java.io :as io]
   [clojure.test :refer [deftest is testing]]
   [codewalk.activity :as activity]
   [codewalk.activity-archive :as archive]
   [codewalk.server :as server])
  (:import
   [java.net URI]
   [java.net.http HttpClient HttpRequest HttpResponse$BodyHandlers]
   [java.nio.charset StandardCharsets]
   [java.nio.file Files OpenOption StandardOpenOption]
   [java.nio.file.attribute FileAttribute]))

(defn- temporary-directory
  []
  (.toFile (Files/createTempDirectory
            "codewalk-activity-archive-test-"
            (make-array FileAttribute 0))))

(defn- delete-tree!
  [directory]
  (doseq [file (sort-by #(.length (.getPath ^java.io.File %)) >
                         (file-seq directory))]
    (Files/deleteIfExists (.toPath ^java.io.File file))))

(defn- event
  ([id session-id]
   (event id session-id {}))
  ([id session-id extra]
   (merge {:schemaVersion 1
           :id            id
           :sessionId     session-id
           :timestamp     "2026-09-11T20:00:00Z"
           :type          "tool.started"
           :workspace     {:id "workspace-1"
                           :root "/Users/example/repository"}}
          extra)))

(defn- recording-id
  [archive-state]
  (-> (archive/list-recordings archive-state {})
      :recordings
      first
      :recordingId))

(defn- http-get
  [client uri origin token]
  (let [builder (HttpRequest/newBuilder (URI/create uri))
        builder (if origin (.header builder "Origin" origin) builder)
        builder (if token
                  (.header builder "X-Codewalk-Activity-Token" token)
                  builder)]
    (.send client
           (.build (.GET builder))
           (HttpResponse$BodyHandlers/ofString))))

(defn- http-post
  [client uri body origin token]
  (let [builder (-> (HttpRequest/newBuilder (URI/create uri))
                    (.header "Content-Type" "application/json")
                    (.header "Origin" origin)
                    (.header "X-Codewalk-Activity-Token" token)
                    (.POST (java.net.http.HttpRequest$BodyPublishers/ofString body))
                    (.build))]
    (.send client builder (HttpResponse$BodyHandlers/ofString))))

(deftest capture-is-opt-in
  (let [parent (temporary-directory)
        directory (io/file parent "archive")
        collector (activity/create-state {:activity-log-dir directory})]
    (try
      (activity/publish! collector (event "event-1" "session-1"))
      (is (not (.exists directory)))
      (finally
        (activity/stop! collector)
        (delete-tree! parent)))))

(deftest workspace-id-alias-is-used-for-live-and-archived-routing
  (let [directory (temporary-directory)
        collector (activity/create-state
                   {:activity-capture? true
                    :activity-log-dir directory})
        workspace-id "workspace-alias"]
    (try
      (let [result (activity/publish!
                    collector
                    (event "workspace-alias-event"
                           "session-alias"
                           {:workspace {:workspaceId workspace-id}
                            :source {:client "copilot-cli"
                                     :kind "hook"}}))
            subscription (activity/subscribe! collector nil workspace-id)]
        (try
          (is (= :accepted (:status result)))
          (is (= ["workspace-alias-event"]
                 (mapv :id (:replay subscription))))
          (let [recordings (:recordings
                            (archive/list-recordings
                             (:archive collector)
                             {:workspace-id workspace-id}))]
            (is (= 1 (count recordings)))
            (is (= workspace-id
                   (get-in (first recordings)
                           [:workspaceSummary :workspaceId]))))
          (finally
            (activity/unsubscribe! collector (:client subscription)))))
      (finally
        (activity/stop! collector)
        (delete-tree! directory)))))

(deftest source-kind-keeps-recordings-independent
  (let [directory (temporary-directory)
        collector (activity/create-state
                   {:activity-capture? true
                    :activity-log-dir directory})
        common {:sessionId "shared-session"
                :workspace {:id "shared-workspace"}}
        publish (fn [id kind]
                  (activity/publish!
                   collector
                   (event id
                          "shared-session"
                          (merge common
                                 {:id id
                                  :source {:client "copilot-cli"
                                           :kind kind}}))))]
    (try
      (publish "hook-event" "hook")
      (publish "sdk-event" "sdk")
      (let [recordings (:recordings
                        (archive/list-recordings (:archive collector) {}))]
        (is (= 2 (count recordings)))
        (is (= #{"copilot-cli|hook||" "copilot-cli|sdk||"}
               (set (map #(get-in % [:sessionSummary :source])
                         recordings)))))
      (finally
        (activity/stop! collector)
        (delete-tree! directory)))))

(deftest recording-manifest-and-recording-sequence-are-independent
  (let [directory (temporary-directory)
        collector (activity/create-state
                   {:activity-capture? true
                    :activity-log-dir directory})]
    (try
      (let [first (activity/publish! collector
                                     (event "event-1" "session-1"
                                            {:sequence 900}))
            second (activity/publish! collector
                                      (event "event-2" "session-1"
                                             {:type "session.ended"}))
            archive-state (:archive collector)
            id (recording-id archive-state)
            manifest (archive/get-recording archive-state id)
            rows (:events (archive/recording-events archive-state id {}))
            files (set (map #(.getName %) (.listFiles directory)))]
        (is (= :accepted (:status first)))
        (is (= :accepted (:status second)))
        (is (= #{"index.json" id} files))
        (is (= "complete" (:status manifest)))
        (is (= 2 (:eventCount manifest)))
        (is (= [1 2] (mapv :recordingSequence rows)))
        (is (every? #(nil? (get-in % [:event :streamSequence])) rows))
        (is (= [1 2] (mapv :recordingSequence rows)))
        (is (= "session.ended"
               (get-in (nth rows 1) [:event :type]))))
      (finally
        (activity/stop! collector)
        (delete-tree! directory)))))

(deftest startup-recovers-a-partial-final-jsonl-line
  (let [directory (temporary-directory)
        first-state (activity/create-state
                     {:activity-capture? true
                      :activity-log-dir directory})]
    (try
      (activity/publish! first-state (event "event-1" "session-1"))
      (let [id (recording-id (:archive first-state))
            events-file (io/file directory id "events.jsonl")]
        (Files/write (.toPath events-file)
                     (.getBytes "{\"recordingSequence\":2"
                                StandardCharsets/UTF_8)
                     (into-array OpenOption
                                 [StandardOpenOption/APPEND
                                  StandardOpenOption/WRITE]))
        (activity/stop! first-state)
        (let [recovered (archive/create-state
                         {:enabled? true
                          :directory directory})
              manifest (archive/get-recording recovered id)
              rows (:events (archive/recording-events recovered id {}))]
          (is (= "partial" (:status manifest)))
          (is (= 1 (:eventCount manifest)))
          (is (= [1] (mapv :recordingSequence rows)))
          (archive/stop! recovered)))
      (finally
        (when-not @(:closed? first-state)
          (activity/stop! first-state))
        (delete-tree! directory)))))

(deftest retention-evicts-oldest-complete-recording-deterministically
  (let [directory (temporary-directory)
        collector (activity/create-state
                   {:activity-capture? true
                    :activity-log-dir directory
                    :activity-max-recordings 2})]
    (try
      (doseq [session ["session-a" "session-b" "session-c"]]
        (activity/publish! collector
                           (event (str session "-start") session))
        (activity/publish! collector
                           (event (str session "-end")
                                  session
                                  {:type "session.ended"})))
      (let [recordings (:recordings (archive/list-recordings
                                     (:archive collector)
                                     {}))
            sessions (set (map #(get-in % [:sessionSummary :sessionId])
                               recordings))]
        (is (= 2 (count recordings)))
        (is (= #{"session-b" "session-c"} sessions)))
      (finally
        (activity/stop! collector)
        (delete-tree! directory)))))

(deftest authenticated-http-read-api-exposes-recording-pages
  (let [directory (temporary-directory)
        token "archive-http-token"
        origin "http://viewer.test"
        instance (server/start! {:port 0
                                  :activity-token token
                                  :activity-origins #{origin}
                                  :activity-capture? true
                                  :activity-log-dir directory})
        http (HttpClient/newHttpClient)
        port (.getPort (.getAddress instance))
        base (str "http://127.0.0.1:" port "/api/activity/recordings")]
    (try
      (let [posted (http-post http
                              (str "http://127.0.0.1:" port
                                   "/api/activity/events")
                              (json/write-str (event "event-1" "session-http"))
                              origin
                              token)
            listed (http-get http (str base "?workspaceId=workspace-1")
                             origin token)
            body (json/read-str (.body listed) :key-fn keyword)
            id (get-in body [:recordings 0 :recordingId])
            detail (http-get http (str base "/" id) origin token)
            detail-body (json/read-str (.body detail) :key-fn keyword)
            events (http-get http (str base "/" id "/events?after=0&limit=1")
                             origin token)
            events-body (json/read-str (.body events) :key-fn keyword)
            unauthorized (http-get http base origin nil)]
        (is (= 202 (.statusCode posted)))
        (is (= 200 (.statusCode listed)))
        (is (= "session-http"
               (get-in body [:recordings 0 :sessionSummary :sessionId])))
        (is (= 200 (.statusCode detail)))
        (is (= id (get-in detail-body [:recording :recordingId])))
        (is (= 200 (.statusCode events)))
        (is (= [1] (mapv :recordingSequence (:events events-body))))
        (is (= 401 (.statusCode unauthorized))))
      (finally
        (server/stop! instance)
        (delete-tree! directory)))))
