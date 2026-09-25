(ns codewalk.parser
  (:require [clojure.data.json :as json]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [codewalk.history :as history])
  (:import [com.sun.net.httpserver HttpExchange]
           [java.io ByteArrayOutputStream]
           [java.net URLDecoder]
           [java.util.concurrent Executors TimeUnit]))

(def ^:private max-body-bytes (* 1024 1024))
(def ^:private max-output-bytes (* 256 1024 1024))
(def ^:private default-timeout-seconds 120.0)
(def ^:private max-timeout-seconds 300.0)

(def ^:private language-aliases
  {"auto" nil
   "python" "python"
   "py" "python"
   "csharp" "csharp"
   "c#" "csharp"
   "c-sharp" "csharp"
   "dotnet" "csharp"
   "typescript-javascript" "typescript-javascript"
   "typescript_javascript" "typescript-javascript"
   "typescriptjavascript" "typescript-javascript"
   "typescript" "typescript-javascript"
   "javascript" "typescript-javascript"
   "ts" "typescript-javascript"
   "js" "typescript-javascript"})

(def ^:private runtime-commands
  {"python" "python3"
   "csharp" "dotnet"
   "typescript-javascript" "node"})

(defn- api-error
  ([status code message] (api-error status code message nil))
  ([status code message details]
   (throw (ex-info message
                   (cond-> {:api-error true
                            :status status
                            :code code}
                     details (assoc :details details))))))

(defn- canonical-file [value]
  (try
    (.getCanonicalFile (io/file value))
    (catch java.io.IOException error
      (api-error 400 "INVALID_PATH" "Path could not be canonicalized."
                 {"cause" (.getMessage error)}))))

(defn- target-root [value]
  (when-not (and (string? value) (not (str/blank? value)))
    (api-error 400 "INVALID_PATH" "Provide a non-empty local path."))
  (when (> (count value) 4096)
    (api-error 400 "INVALID_PATH" "Path exceeds the maximum supported length."))
  (when (str/includes? value "\u0000")
    (api-error 400 "INVALID_PATH" "Path contains a NUL character."))
  (let [file (canonical-file value)]
    (when-not (.exists file)
      (api-error 400 "INVALID_PATH" "Path does not exist."))
    (if (.isDirectory file) file (.getParentFile file))))

(defn- config-path [root value]
  (when value
    (when-not (string? value)
      (api-error 400 "INVALID_CONFIG_PATH" "configPath must be a string."))
    (let [path (canonical-file (if (.isAbsolute (io/file value))
                                 value
                                 (io/file root value)))]
      (when-not (.isFile path)
        (api-error 400 "INVALID_CONFIG_PATH" "configPath must point to a local file."))
      (.getPath path))))

(defn- normalize-language [value]
  (let [key (some-> value str str/trim str/lower-case)]
    (when (and value (not (contains? language-aliases key)))
      (api-error 400 "UNSUPPORTED_LANGUAGE"
                 "language must be auto, python, csharp, or typescript-javascript."
                 {"language" value
                  "supported" ["auto" "python" "csharp" "typescript-javascript"]}))
    (get language-aliases (or key "auto"))))

(defn- timeout-seconds [value]
  (let [timeout (if (nil? value) default-timeout-seconds
                    (if (number? value) (double value)
                        (api-error 400 "INVALID_TIMEOUT"
                                   "timeoutSeconds must be a number.")))]
    (when (or (< timeout 0.1) (> timeout max-timeout-seconds))
      (api-error 400 "INVALID_TIMEOUT"
                 (format "timeoutSeconds must be between 0.1 and %.0f." max-timeout-seconds)
                 {"min" 0.1 "max" max-timeout-seconds}))
    timeout))

(defn- read-limited [stream limit]
  (let [buffer (byte-array 8192)
        output (ByteArrayOutputStream.)]
    (loop [total 0]
      (let [count (.read stream buffer)]
        (if (neg? count)
          (.toString output "UTF-8")
          (let [next-total (+ total count)]
            (when (> next-total limit)
              (api-error 502 "OUTPUT_TOO_LARGE" "Parser output exceeded the response limit."
                         {"limitBytes" limit}))
            (.write output buffer 0 count)
            (recur next-total)))))))

(defn- run-command! [parser-root args timeout]
  (let [builder (doto (ProcessBuilder. (into-array String args))
                   (.directory (io/file parser-root)))]
    (.put (.environment builder) "PYTHONUNBUFFERED" "1")
    (try
      (let [process (.start builder)
            executor (Executors/newFixedThreadPool 2)
            stdout (.submit executor
                            (reify java.util.concurrent.Callable
                              (call [_]
                                (with-open [stream (.getInputStream process)]
                                  (read-limited stream max-output-bytes)))))
            stderr (.submit executor
                            (reify java.util.concurrent.Callable
                              (call [_]
                                (with-open [stream (.getErrorStream process)]
                                  (read-limited stream max-output-bytes)))))
            finished (.waitFor process (long (* timeout 1000)) TimeUnit/MILLISECONDS)]
        (try
          (if-not finished
            (do
              (.destroyForcibly process)
              (.waitFor process 1 TimeUnit/SECONDS)
              (api-error 504 "ADAPTER_TIMEOUT" "Parser adapter exceeded its timeout."
                         {"timeoutSeconds" timeout
                          "command" args}))
            {:exit (.exitValue process)
             :stdout (.get stdout)
             :stderr (.get stderr)})
          (catch java.util.concurrent.ExecutionException error
            (.destroyForcibly process)
            (.waitFor process 1 TimeUnit/SECONDS)
            (let [cause (.getCause error)]
              (if (instance? clojure.lang.ExceptionInfo cause)
                (throw cause)
                (api-error 502 "OUTPUT_READ_FAILURE" "Unable to capture parser output."
                           {"cause" (.getMessage cause)}))))
          (finally
            (.shutdownNow executor))))
      (catch java.io.IOException error
        (api-error 503 "MISSING_COMMAND"
                   (str "Parser runtime or command is unavailable: " (first args))
                   {"command" args
                    "cause" (.getMessage error)})))))

(defn- dispatcher-error [result]
  (let [parsed (try
                 (json/read-str (:stderr result))
                 (catch Exception _ nil))
        error (get parsed "error")]
    (if (map? error)
      (let [code (or (get error "code") "ADAPTER_FAILURE")
            status (case code
                     ("MISSING_COMMAND" "MISSING_ADAPTER_DEPENDENCY") 503
                     "ADAPTER_TIMEOUT" 504
                     ("AMBIGUOUS_REPOSITORY" "NO_ADAPTER") 422
                     "INVALID_REPOSITORY" 400
                     ("UNKNOWN_ADAPTER" "INVALID_PROJECT_FILE") 400
                     ("INVALID_CONFIG" "CONFIG_READ") 400
                     502)]
        (api-error status code
                   (or (get error "message") "Parser dispatcher failed.")
                   (get error "details")))
      (api-error 502 "ADAPTER_FAILURE"
                 (if (pos? (:exit result))
                   "Parser dispatcher failed."
                   "Parser dispatcher returned malformed output.")
                 {"exitCode" (:exit result)
                  "stderr" (subs (:stderr result) 0 (min 2000 (count (:stderr result))))}))))

(defn- parse-dispatcher-output [result]
  (try
    (let [value (json/read-str (:stdout result))]
      (when-not (map? value)
        (api-error 502 "MALFORMED_OUTPUT" "Parser dispatcher output must be a JSON object."))
      value)
    (catch clojure.lang.ExceptionInfo error
      (throw error))
    (catch Exception _
      (api-error 502 "MALFORMED_JSON" "Parser dispatcher returned malformed JSON."
                 {"stdout" (subs (:stdout result) 0 (min 2000 (count (:stdout result))))}))))

(defn- dispatch! [parser-root command root options timeout]
  (let [args (cond-> ["python3" "-B" "-m" "parser.orchestration.dispatcher"
                      command (.getPath root)]
               (:adapter options) (conj "--adapter" (:adapter options))
               (:config options) (conj "--config" (:config options))
               (:project-file options) (conj "--project-file" (:project-file options))
               (false? (:include-ir? options)) (conj "--omit-ir"))
        result (run-command! parser-root args timeout)]
    (if (zero? (:exit result))
      (parse-dispatcher-output result)
      (if (and (seq (:stdout result))
               (try (map? (json/read-str (:stdout result))) (catch Exception _ false)))
        (let [value (json/read-str (:stdout result))]
          (if (= "fatal" (get-in value ["analysis" "result_status"]))
            value
            (dispatcher-error result)))
        (dispatcher-error result)))))

(defn- graph-envelope [result adapter include-ir?]
  (let [analysis (get result "analysis")
        status (get analysis "result_status")
        selected (or (get analysis "adapter") adapter)]
    (when-not (and (or (not include-ir?) (map? (get result "ir")))
                   (map? (get result "stats"))
                   (vector? (get result "nodes"))
                   (vector? (get result "edges")))
      (api-error 502 "MALFORMED_OUTPUT"
                 "Parser dispatcher output did not contain a valid graph envelope."))
    (when (= "fatal" status)
      (api-error 502 "ADAPTER_FATAL" "Parser adapter reported a fatal analysis failure."
                 {"language" selected
                  "analysis" analysis
                  "diagnostics" (get result "diagnostics" [])}))
    {:language selected
     :graph (dissoc result "ir" "diagnostics")
     :ir (get result "ir")
     :diagnostics (get result "diagnostics" [])
     :status (or status "complete")}))

(defn- relative-path [root file]
  (when file
    (let [root-path (.toPath (io/file root))
          file-path (.toPath (io/file file))]
      (str (.normalize (.relativize root-path file-path))))))

(defn- revision-ref [value field]
  (when (some? value)
    (when-not (string? value)
      (api-error 400 "INVALID_COMMIT" (str field " must be a Git ref string.")
                 {field value}))
    value))

(defn- revision-response [target-root commit parent mode metadata envelope]
  (let [graph (:graph envelope)
        graph (assoc graph
                     "repo" {"name" (.getName (io/file target-root))
                             "root" (.getPath (io/file target-root))
                             "commit" commit}
                     "history" {"commits"
                                [(history/changed-elements metadata
                                                           (get graph "nodes")
                                                           (get graph "edges"))]})]
    (assoc envelope
           :graph graph
           :revision (cond-> {"commit" commit
                              "mode" mode
                              "changedFiles" (get metadata "changedFiles" [])
                              "addedFiles" (get metadata "addedFiles" [])
                              "deletedFiles" (get metadata "deletedFiles" [])
                              "renamedFiles" (get metadata "renamedFiles" [])
                              "limitations" (get metadata "limitations" [])}
                       parent (assoc "parentCommit" parent)))))

(defn- json-envelope [envelope]
  (cond-> {"ok" true
           "language" (:language envelope)
           "graph" (:graph envelope)
           "ir" (:ir envelope)
           "diagnostics" (:diagnostics envelope)
           "status" (:status envelope)}
    (:revision envelope) (assoc "revision" (:revision envelope))))

(defn- client-envelope [body envelope]
  (cond-> (json-envelope envelope)
    (= false (get body "includeIr")) (dissoc "ir")))

(defn- cache-language [language include-ir?]
  (if include-ir?
    language
    (str language "-graph")))

(defn- revision-analysis [parser-root target-root body adapter config timeout include-ir?]
  (let [commit-ref (revision-ref (get body "commit") "commit")
        previous-ref (revision-ref (get body "previousCommit") "previousCommit")]
    (when (and (nil? commit-ref) previous-ref)
      (api-error 400 "INVALID_COMMIT"
                 "previousCommit requires commit."
                 {"previousCommit" previous-ref}))
    (let [repo (history/repository-root target-root)
          commit (history/resolve-commit repo commit-ref)
          previous (when previous-ref (history/resolve-commit repo previous-ref))
          cache-languages (if adapter
                           [adapter]
                           ["auto" "python" "csharp" "typescript-javascript"])
          cached (or (some #(history/cached-value repo (cache-language % include-ir?) commit)
                           cache-languages)
                     (when (false? include-ir?)
                       (some #(history/cached-value repo % commit)
                             cache-languages)))]
      (if cached
        (assoc cached :revision (assoc (:revision cached) "mode" "cached"))
        (let [metadata (history/commit-metadata repo commit)
              parent (get metadata "parentCommit")
              mode (if (and previous parent (= previous parent))
                     "incremental-map"
                     "full")
              limitations (cond-> ["deletions are absent from the current graph"
                                   "rename and overload edge cases may be ambiguous"
                                   "adapters are fully reparsed; changed-file APIs are not used"
                                   "generated/vendor changes may be noisy"
                                   "shallow or missing Git commits limit history context"]
                            (and previous (not= previous parent))
                            (conj "previousCommit is not adjacent; a full snapshot was analyzed"))
              config-file (when config (relative-path target-root config))
              project-file (get body "projectFile")
              _ (when (and config-file
                           (str/starts-with? config-file "../"))
                  (api-error 400 "INVALID_CONFIG_PATH"
                             "configPath must be inside the selected repository."))
              logical-root (history/repository-relative repo target-root)
              response
              (history/with-archive
                repo commit logical-root
                (fn [snapshot]
                  (let [result (dispatch! parser-root "analyze" snapshot
                                          (cond-> {:adapter adapter
                                                   :config config-file
                                                   :include-ir? include-ir?}
                                           project-file (assoc :project-file project-file))
                                          timeout)
                        envelope (graph-envelope result adapter include-ir?)
                        envelope (revision-response target-root commit parent mode
                                                     (assoc metadata
                                                            "limitations" limitations)
                                                     envelope)]
                    (assoc envelope
                           :revision (assoc (:revision envelope) "mode" mode)))))]
          (history/cache! repo (cache-language (:language response) include-ir?) commit response)
          (when (nil? adapter)
            (history/cache! repo (cache-language "auto" include-ir?) commit response))
          response)))))

(defn- command-available? [command]
  (try
    (let [process (.start (ProcessBuilder. (into-array String [command "--version"])))
          finished (.waitFor process 2 TimeUnit/SECONDS)]
      (when-not finished (.destroyForcibly process))
      (and finished (zero? (.exitValue process))))
    (catch java.io.IOException _ false)))

(defn- enrich-capability [parser-root adapter]
  (let [name (get adapter "name")
        configured-command (first (get adapter "command"))
        command (if (= configured-command "{python}")
                  "python3"
                  (or configured-command (get runtime-commands name)))
        command-available (boolean (and command (command-available? command)))
        dist-present (.isFile (io/file parser-root "parser" "typescript-javascript" "dist" "index.js"))
        reasons (cond-> []
                  (not command-available)
                  (conj (str "Runtime command is unavailable: " command "."))
                  (and (= name "typescript-javascript") (not dist-present))
                  (conj "Checked-in TypeScript adapter dist/index.js is not built."))]
    (assoc adapter
           "runtimeCommand" command
           "commandAvailable" command-available
           "runtimeAvailable" command-available
           "available" (empty? reasons)
           "unavailableReasons" reasons)))

(defn capabilities [parser-root default-root path config]
  (let [root (target-root (or path default-root parser-root))
        result (dispatch! parser-root "capabilities" root
                          {:config (config-path root config)}
                          20.0)
        adapters (mapv #(enrich-capability parser-root %) (get result "adapters" []))
        repository (get result "repository")]
    {"ok" true
     "path" (.getPath root)
     "repository" repository
     "languages" (get repository "candidates" [])
     "adapters" adapters}))

(defn analyze [parser-root default-root body]
  (when-not (map? body)
    (api-error 400 "INVALID_BODY" "Request body must be a JSON object."))
  (let [root (target-root (get body "path"))
        adapter (normalize-language (get body "language" "auto"))
        include-ir? (not= false (get body "includeIr"))
        config (config-path root (get body "configPath"))
        timeout (timeout-seconds (get body "timeoutSeconds"))
        project-file (get body "projectFile")
        project-path (when (string? project-file)
                       (canonical-file (io/file root project-file)))]
    (when (and project-file (not (string? project-file)))
      (api-error 400 "INVALID_PROJECT_FILE" "projectFile must be a string."))
    (when (and project-file
               (or (> (count project-file) 4096)
                   (.isAbsolute (io/file project-file))
                   (not (.startsWith (.toPath project-path) (.toPath root)))
                   (not (.isFile project-path))))
      (api-error 400 "INVALID_PROJECT_FILE"
                 "projectFile must be an existing repository-relative file."))
    (if (or (some? (get body "commit"))
            (some? (get body "previousCommit")))
      (let [response (revision-analysis parser-root root body adapter config timeout include-ir?)]
        (client-envelope body response))
      (let [result (dispatch! parser-root "analyze" root
                              (cond-> {:adapter adapter
                                       :config config
                                       :include-ir? include-ir?}
                                project-file (assoc :project-file project-file))
                              timeout)
            envelope (graph-envelope result adapter include-ir?)]
        (client-envelope body envelope)))))

(defn- read-request-body [^HttpExchange exchange]
  (with-open [stream (.getRequestBody exchange)]
    (let [buffer (byte-array 8192)
          output (ByteArrayOutputStream.)]
      (loop [total 0]
        (let [count (.read stream buffer)]
          (if (neg? count)
            (.toString output "UTF-8")
            (let [next-total (+ total count)]
              (when (> next-total max-body-bytes)
                (api-error 413 "REQUEST_TOO_LARGE" "Parser request body is too large."
                           {"limitBytes" max-body-bytes}))
              (.write output buffer 0 count)
              (recur next-total))))))))

(defn- parse-body [^HttpExchange exchange]
  (let [text (read-request-body exchange)]
    (try
      (json/read-str text)
      (catch Exception _
        (api-error 400 "MALFORMED_JSON" "Request body must contain valid JSON.")))))

(defn- query-params [^HttpExchange exchange]
  (let [query (.getRawQuery (.getRequestURI exchange))]
    (into {}
          (keep (fn [part]
                  (let [[key value] (str/split part #"=" 2)]
                    (when (and key value)
                      [(keyword (URLDecoder/decode key "UTF-8"))
                       (URLDecoder/decode value "UTF-8")]))))
          (str/split (or query "") #"&"))))

(defn capabilities-route [^HttpExchange exchange default-root parser-root]
  (if (= "GET" (.getRequestMethod exchange))
    (let [params (query-params exchange)]
      (capabilities parser-root default-root (:path params) (:config params)))
    (api-error 405 "METHOD_NOT_ALLOWED" "Only GET is supported.")))

(defn analyze-route [^HttpExchange exchange default-root parser-root]
  (if (= "POST" (.getRequestMethod exchange))
    (analyze parser-root default-root (parse-body exchange))
    (api-error 405 "METHOD_NOT_ALLOWED" "Only POST is supported.")))
