(ns codewalk.server
  (:require [clojure.data.json :as json]
            [clojure.set :as set]
            [clojure.java.io :as io]
            [clojure.java.shell :as shell]
            [clojure.string :as str]
            [codewalk.activity :as activity]
            [codewalk.analyzer :as analyzer]
            [codewalk.parser :as parser]
            [codewalk.temporal :as temporal])
  (:import [com.sun.net.httpserver HttpExchange HttpHandler HttpServer]
           [java.net InetSocketAddress URLDecoder]
           [java.nio.charset StandardCharsets]
           [java.nio.file Files]
           [java.util.concurrent ArrayBlockingQueue Executors
            TimeUnit ThreadPoolExecutor ThreadPoolExecutor$AbortPolicy]))

(defn- canonical-path [path]
  (str (.getCanonicalFile (io/file path))))

(defn- git-root [path]
  (let [{:keys [exit out]} (shell/sh "git" "-C" path "rev-parse" "--show-toplevel")]
    (when (zero? exit)
      (str/trim out))))

(defn- fail [status message]
  (throw (ex-info message {:status status})))

(defn- repository-root [path default-root]
  (let [candidate (or (when-not (str/blank? path) path) default-root)]
    (when (str/blank? candidate)
      (fail 400 "Provide a local Git repository path."))
    (or (git-root (canonical-path candidate))
        (fail 400 "That path is not inside a Git repository."))))

(defn- timeline-commit [line]
  (let [[hash short-hash timestamp author message] (str/split line #"\u001f" 5)]
    {:id hash
     :hash hash
     :shortHash short-hash
     :message message
     :author author
     :timestamp timestamp
     :changedFiles []
     :addedFiles []
     :changedNodeIds []
     :addedNodeIds []}))

(defn- commit-timeline [repo-root]
  (let [{:keys [exit out]} (shell/sh "git" "-C" repo-root "log" "--reverse"
                                      "--format=%H%x1f%h%x1f%aI%x1f%an%x1f%s"
                                      "--name-only")]
    (when-not (zero? exit)
      (fail 400 "Unable to read Git history for that repository."))
    (->> (str/split-lines out)
         (reduce (fn [{:keys [commits current] :as state} line]
                   (if (str/includes? line "\u001f")
                     {:commits (cond-> commits current (conj current))
                      :current (timeline-commit line)}
                     (if (or (nil? current) (str/blank? line))
                       state
                       {:commits commits
                        :current (update current :changedFiles conj line)})))
                 {:commits [] :current nil})
         ((fn [{:keys [commits current]}] (cond-> commits current (conj current))))
         vec)))

(defn- resolve-commit [repo-root ref]
  (let [ref (or (when-not (str/blank? ref) ref) "HEAD")
        {:keys [exit out]} (shell/sh "git" "-C" repo-root "rev-parse" "--verify"
                                      "--end-of-options" (str ref "^{commit}"))]
    (when-not (zero? exit)
      (fail 404 "That Git commit could not be resolved."))
    (str/trim out)))

(defn- repository-info [root]
  (let [commits (commit-timeline root)]
    (when (empty? commits)
      (fail 400 "That Git repository has no commits."))
    {"name" (.getName (io/file root))
     "root" root
     "head" (:hash (last commits))
     "commitCount" (count commits)
     "commits" commits}))

(defn- run-process! [args]
  (let [process-builder (doto (ProcessBuilder. (into-array String args))
                          (.redirectErrorStream true))
        process (.start process-builder)
        output (slurp (.getInputStream process))
        exit (.waitFor process)]
    (when-not (zero? exit)
      (fail 500 (str "Command failed: " (str/trim output))))
    output))

(defn- delete-tree! [directory]
  (doseq [file (sort-by #(.length (.getPath ^java.io.File %)) > (file-seq directory))]
    (Files/deleteIfExists (.toPath ^java.io.File file))))

(defonce ^:private revision-cache (atom {}))
(defonce ^:private activity-resources (atom {}))

(defn- graph-stats [nodes edges]
  (let [node-counts (frequencies (map :kind nodes))
        edge-counts (frequencies (map :kind edges))]
    {"nodes" (count nodes)
     "edges" (count edges)
     "namespaces" (get node-counts "namespace" 0)
     "vars" (get node-counts "var" 0)
     "keywords" (get node-counts "keyword" 0)
     "requires" (get edge-counts "requires" 0)
     "calls" (get edge-counts "calls" 0)
     "mentions" (get edge-counts "mentions" 0)
     "externalNodes" (count (filter :external nodes))}))

(defn- source-path? [path]
  (boolean (re-find #"\.(?:clj|cljs|cljc)$" path)))

(defn- git-change-paths [repo-root hash]
  (let [{:keys [exit out]} (shell/sh "git" "-C" repo-root "show" "--format="
                                      "--name-status" "--find-renames" hash)]
    (if (zero? exit)
      (->> (str/split-lines out)
           (remove str/blank?)
           (mapcat (fn [line]
                     (let [[status & paths] (str/split line #"\t")]
                       (if (str/starts-with? status "R") paths [(last paths)]))))
           (remove str/blank?)
           distinct
           vec)
      [])))

(defn- parent-commit [repo-root hash]
  (let [{:keys [exit out]} (shell/sh "git" "-C" repo-root "rev-parse" (str hash "^"))]
    (when (zero? exit) (str/trim out))))

(defn- changed-source-paths [directory paths]
  (->> paths
       (filter source-path?)
       (keep (fn [path]
               (let [file (io/file directory path)]
                 (when (.isFile file) (canonical-path file)))))
       vec))

(defn- merge-node [base-node delta-node]
  (if (and base-node (= "keyword" (:kind delta-node)))
    (cond-> delta-node
      (and (:usageCount base-node) (:usageCount delta-node))
      (assoc :usageCount (max (:usageCount base-node) (:usageCount delta-node))))
    delta-node))

(defn- edge-evidence [edge]
  (if (seq (:evidence edge))
    (:evidence edge)
    [(select-keys edge [:source :file :row :col :endRow :endCol])]))

(defn- evidence-sort-key [evidence]
  [(or (:file evidence) "")
   (or (:row evidence) Long/MAX_VALUE)
   (or (:col evidence) Long/MAX_VALUE)
   (or (:endRow evidence) Long/MAX_VALUE)
   (or (:endCol evidence) Long/MAX_VALUE)])

(defn- edge-occurrences [edge changed-files]
  (->> (edge-evidence edge)
       (remove #(contains? changed-files (:file %)))
       (sort-by evidence-sort-key)
       vec))

(defn- legacy-edge-kept? [edge old-changed-ids removed-ids]
  (and (empty? (:evidence edge))
       (not (contains? old-changed-ids (:source edge)))
       (not (contains? old-changed-ids (:target edge)))
       (not (contains? removed-ids (:source edge)))
       (not (contains? removed-ids (:target edge)))))

(defn- with-edge-evidence [edge evidence]
  (let [evidence (vec (sort-by evidence-sort-key (distinct evidence)))
        first-evidence (first evidence)]
    (cond-> (assoc edge
                   :occurrenceCount (count evidence)
                   :evidence evidence)
      first-evidence (assoc :file (:file first-evidence)
                           :row (:row first-evidence)
                           :col (:col first-evidence)
                           :endRow (:endRow first-evidence)
                           :endCol (:endCol first-evidence)))))

(defn- merge-edge [base-edge delta-edge]
  (with-edge-evidence (merge base-edge delta-edge)
                      (concat (edge-evidence base-edge)
                              (edge-evidence delta-edge))))

(defn- merge-graph [base delta changed-paths]
  (let [changed-files (set changed-paths)
        base-by-id (into {} (map (juxt :id identity) (:nodes base)))
        old-changed-ids (into #{} (keep (fn [node]
                                          (when (contains? changed-files (:file node))
                                            (:id node))))
                              (:nodes base))
        delta-by-id (into {} (map (fn [node]
                                    [(:id node) (merge-node (get base-by-id (:id node)) node)])
                                  (:nodes delta)))
        delta-ids (set (keys delta-by-id))
        removed-ids (set/difference old-changed-ids delta-ids)
        nodes (->> (concat (remove #(contains? changed-files (:file %)) (:nodes base))
                           (vals delta-by-id))
                   (reduce (fn [result node] (assoc result (:id node) node)) {})
                   vals
                   (sort-by :id)
                   vec)
        node-ids (set (map :id nodes))
        retained-base-edges (keep (fn [edge]
                                   (let [occurrences (edge-occurrences edge changed-files)]
                                     (when (or (seq occurrences)
                                               (legacy-edge-kept? edge old-changed-ids removed-ids))
                                       (with-edge-evidence edge occurrences))))
                                 (:edges base))
        edges (->> (concat retained-base-edges (:edges delta))
                   (filter #(and (contains? node-ids (:source %))
                                (contains? node-ids (:target %))))
                   (reduce (fn [result edge]
                            (update result (:id edge)
                                    (fn [existing]
                                      (if existing
                                        (merge-edge existing edge)
                                        edge))))
                          {})
                   vals
                   (sort-by :id)
                   vec)]
    (assoc base
           :generatedAt (str (java.time.Instant/now))
           :nodes nodes
           :edges edges
           :stats (graph-stats nodes edges))))

(defn- commit-graph [repo-root commit graph mode analyzed-file-count]
  (let [commit-with-nodes (analyzer/changed-element-ids commit (:nodes graph) (:edges graph))]
    (assoc graph
           :repo {"name" (.getName (io/file repo-root)) "root" repo-root}
           :analysis {"mode" mode "files" analyzed-file-count}
           :history {:commits [commit-with-nodes]})))

(defn- archive-revision! [repo-root commit directory]
  (let [archive (Files/createTempFile "codewalk-archive-" ".tar" (make-array java.nio.file.attribute.FileAttribute 0))]
    (try
      (run-process! ["git" "-C" repo-root "archive" "--format=tar"
                     "--output" (str archive) commit])
      (run-process! ["tar" "-xf" (str archive) "-C" (.getPath ^java.io.File directory)])
      (finally
        (Files/deleteIfExists archive)))))

(defn- full-graph-at [repo-root commit-hash]
  (let [directory (.toFile (Files/createTempDirectory "codewalk-revision-" (make-array java.nio.file.attribute.FileAttribute 0)))]
    (try
      (archive-revision! repo-root commit-hash directory)
      (let [paths (analyzer/source-paths directory)
            graph (analyzer/analyze {:paths paths
                                     :repo-root (str directory)
                                     :include-external? true})
            commit (analyzer/commit-metadata repo-root commit-hash)]
        (commit-graph repo-root commit graph "full" (count paths)))
      (finally
        (delete-tree! directory)))))

(defn- incremental-graph-at [repo-root commit-hash base-graph]
  (let [directory (.toFile (Files/createTempDirectory "codewalk-revision-" (make-array java.nio.file.attribute.FileAttribute 0)))]
    (try
      (archive-revision! repo-root commit-hash directory)
      (let [changed-paths (git-change-paths repo-root commit-hash)
            paths (changed-source-paths directory changed-paths)
            delta (analyzer/analyze {:paths paths
                                     :repo-root (str directory)
                                     :include-external? true})
            graph (merge-graph base-graph delta changed-paths)
            commit (analyzer/commit-metadata repo-root commit-hash)]
        (commit-graph repo-root commit graph "incremental" (count paths)))
      (finally
        (delete-tree! directory)))))

(defn- graph-at [repo-root ref]
  (let [commit-hash (resolve-commit repo-root ref)
        cached (get @revision-cache repo-root)]
    (if (= commit-hash (:commit cached))
      (:graph cached)
      (let [base-commit (:commit cached)
            base-graph (:graph cached)
            [graph mode]
            (if (and base-commit base-graph (= base-commit (parent-commit repo-root commit-hash)))
              [(incremental-graph-at repo-root commit-hash base-graph) "incremental"]
              [(full-graph-at repo-root commit-hash) "full"])
            graph (assoc graph :analysis (assoc (:analysis graph) "mode" mode))]
        (swap! revision-cache assoc repo-root {:commit commit-hash :graph graph})
        graph))))

(defn- query-params [^HttpExchange exchange]
  (let [query (.getRawQuery (.getRequestURI exchange))]
    (into {}
          (keep (fn [part]
                  (let [[key value] (str/split part #"=" 2)]
                    (when (and key value)
                      [(keyword (URLDecoder/decode key "UTF-8"))
                       (URLDecoder/decode value "UTF-8")]))))
          (str/split (or query "") #"&"))))

(defn- send-response! [^HttpExchange exchange status content-type body]
  (let [bytes (.getBytes body StandardCharsets/UTF_8)]
    (.set (.getResponseHeaders exchange) "Access-Control-Allow-Origin" "*")
    (.set (.getResponseHeaders exchange) "Access-Control-Allow-Methods" "GET, POST, OPTIONS")
    (.set (.getResponseHeaders exchange) "Access-Control-Allow-Headers"
          "Content-Type, Last-Event-ID")
    (.set (.getResponseHeaders exchange) "Content-Type" content-type)
    (.sendResponseHeaders exchange status (alength bytes))
    (with-open [output (.getResponseBody exchange)]
      (.write output bytes))))

(defn- send-json! [exchange status value]
  (send-response! exchange status "application/json; charset=utf-8" (json/write-str value)))

(defn- handler [default-root route]
  (reify HttpHandler
    (handle [_ exchange]
      (try
        (if (= "OPTIONS" (.getRequestMethod exchange))
          (send-response! exchange 204 "text/plain; charset=utf-8" "")
          (route exchange default-root))
        (catch clojure.lang.ExceptionInfo error
          (let [data (ex-data error)
                status (or (:status data) 500)]
            (if (:api-error data)
              (send-json! exchange status
                          {"ok" false
                           "error" (cond-> {"code" (or (:code data) "INTERNAL_ERROR")
                                            "message" (.getMessage error)}
                                     (:details data) (assoc "details" (:details data)))})
              (send-json! exchange status {"error" (.getMessage error)}))))
        (catch Exception error
          (send-json! exchange 500 {"error" (.getMessage error)}))))))

(defn- repository-route [exchange default-root]
  (if (= "GET" (.getRequestMethod exchange))
    (let [root (repository-root (:path (query-params exchange)) default-root)]
      (send-json! exchange 200 (repository-info root)))
    (send-json! exchange 405 {"error" "Only GET is supported."})))

(defn- graph-route [exchange default-root]
  (if (= "GET" (.getRequestMethod exchange))
    (let [params (query-params exchange)
          root (repository-root (:path params) default-root)
          graph (graph-at root (:commit params))]
      (send-json! exchange 200 graph))
    (send-json! exchange 405 {"error" "Only GET is supported."})))

(defn- namespace-file-map [graph]
  (reduce (fn [result node]
            (when-let [file (:file node)]
              (when-let [namespace (or (:namespace node)
                                       (when (= "namespace" (:kind node))
                                         (:label node)))]
                (update result file (fnil conj #{}) namespace)))
            result)
          {}
          (:nodes graph)))

(defn- temporal-route [exchange default-root]
  (if (= "GET" (.getRequestMethod exchange))
    (let [params (query-params exchange)
          root (repository-root (:path params) default-root)
          repository (repository-info root)
          graph (graph-at root (:commit params))
          observations (temporal/commit-file-observations
                        (get repository "commits")
                        (namespace-file-map graph))
          couplings (temporal/aggregate-namespace-coupling observations)
          observable (count (filter #(seq (:namespaces %)) observations))
          unmapped-files (reduce + 0 (map #(count (:unmapped-files %)) observations))]
      (send-json! exchange 200
                  {"couplings" couplings
                   "observations" observations
                   "coverage" {"requestedCommitCount" (count (get repository "commits"))
                                "observableCommitCount" observable
                                "unmappedFileCount" unmapped-files
                                "state" (if (= observable (count observations))
                                          "complete"
                                          "partial")}}))
    (send-json! exchange 405 {"error" "Only GET is supported."})))

(defn start!
  [{:keys [port repo-root parser-root activity-origins activity-token
           activity-stream-threads activity-stream-queue-limit
           activity-max-workspaces activity-capture? activity-capture
           activity-log-dir activity-archive-dir
           activity-max-recordings activity-max-events activity-max-bytes
           activity-max-age-ms activity-max-age-days]
    :or {port                        4180
         activity-stream-threads     32
         activity-stream-queue-limit 32}}]
  (let [parser-root (or parser-root (System/getProperty "user.dir"))
        parser-default-root (or repo-root parser-root)
        env-capture (some-> (System/getenv "CODEWALK_ACTIVITY_CAPTURE")
                            str/lower-case)
        capture? (if (some? activity-capture?)
                   (boolean activity-capture?)
                   (if (some? activity-capture)
                     (boolean activity-capture)
                     (#{"1" "true" "yes" "on"} env-capture)))
        activity-log-dir (or activity-log-dir
                             activity-archive-dir
                             (System/getenv "CODEWALK_ACTIVITY_LOG_DIR"))
        protected-roots (vec (remove str/blank?
                                     (map str [parser-default-root])))
        server (HttpServer/create (InetSocketAddress. "127.0.0.1" port) 0)
        activity-options (cond-> {}
                          activity-origins (assoc :origins activity-origins)
                          activity-token (assoc :token activity-token)
                          true (assoc :activity-capture? capture?)
                          (some? activity-log-dir)
                          (assoc :activity-log-dir activity-log-dir)
                          true (assoc :activity-protected-roots
                                      protected-roots)
                          (some? activity-max-recordings)
                          (assoc :activity-max-recordings
                                 activity-max-recordings)
                          (some? activity-max-events)
                          (assoc :activity-max-events activity-max-events)
                          (some? activity-max-bytes)
                          (assoc :activity-max-bytes activity-max-bytes)
                          (some? activity-max-age-ms)
                          (assoc :activity-max-age-ms activity-max-age-ms)
                          (some? activity-max-age-days)
                          (assoc :activity-max-age-days activity-max-age-days)
                          (some? activity-max-workspaces)
                          (assoc :max-workspaces activity-max-workspaces))
        activity-state (activity/create-state activity-options)
        ;; Keep long-lived SSE connections away from the normal request pool.
        streaming-executor (ThreadPoolExecutor.
                            activity-stream-threads
                            activity-stream-threads
                            0
                            TimeUnit/MILLISECONDS
                            (ArrayBlockingQueue. activity-stream-queue-limit)
                            (ThreadPoolExecutor$AbortPolicy.))
        request-executor (Executors/newFixedThreadPool 8)]
    (.createContext server "/api/repository" (handler repo-root repository-route))
    (.createContext server "/api/graph" (handler repo-root graph-route))
    (.createContext server "/api/temporal" (handler repo-root temporal-route))
    (.createContext server "/api/activity/events"
                    (activity/http-handler activity-state
                                           #(activity/events-route % activity-state)))
    (.createContext server "/api/activity/stream"
                    (activity/http-handler activity-state
                                           #(activity/stream-route %
                                                                   activity-state
                                                                   streaming-executor)))
    (.createContext server "/api/activity/recordings"
                    (activity/http-handler activity-state
                                           #(activity/recordings-route %
                                                                      activity-state)))
    (.createContext server "/api/parser/capabilities"
                    (handler parser-default-root
                            (fn [exchange default-root]
                              (send-json! exchange 200
                                          (parser/capabilities-route exchange default-root parser-root)))))
    (.createContext server "/api/parser/analyze"
                    (handler parser-default-root
                            (fn [exchange default-root]
                              (send-json! exchange 200
                                          (parser/analyze-route exchange default-root parser-root)))))
    (.createContext server "/api/health"
                    (handler repo-root (fn [exchange _]
                                         (send-json! exchange 200 {"status" "ok"}))))
    (.setExecutor server request-executor)
    (swap! activity-resources assoc server {:state activity-state
                                            :executor streaming-executor
                                            :request-executor request-executor})
    (.start server)
    (println (str "Codewalk API listening at http://127.0.0.1:" port))
    server))

(defn wait! [server]
  (try
    @(promise)
    (finally
      (when-let [{:keys [state executor request-executor]} (get @activity-resources server)]
        (activity/stop! state)
        (.shutdownNow ^java.util.concurrent.ExecutorService executor)
        (.shutdownNow ^java.util.concurrent.ExecutorService request-executor)
        (swap! activity-resources dissoc server))
      (.stop ^HttpServer server 0))))

(defn stop!
  "Stop a Codewalk server and its activity stream resources."
  [server]
  (when-let [{:keys [state executor request-executor]} (get @activity-resources server)]
    (activity/stop! state)
    (.shutdownNow ^java.util.concurrent.ExecutorService executor)
    (.shutdownNow ^java.util.concurrent.ExecutorService request-executor)
    (swap! activity-resources dissoc server))
  (.stop ^HttpServer server 0))
