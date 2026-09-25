(ns codewalk.parser-test
  (:require [clojure.data.json :as json]
            [clojure.java.io :as io]
            [clojure.java.shell :as shell]
            [clojure.test :refer [deftest is testing]]
            [codewalk.history :as history]
            [codewalk.parser :as parser]))

(defn- temp-repo []
  (let [root (.toFile (java.nio.file.Files/createTempDirectory
                       "codewalk-parser-test-"
                       (make-array java.nio.file.attribute.FileAttribute 0)))]
    (spit (io/file root "main.py") "def hello():\n    return 1\n")
    root))

(defn- write-config! [root mode]
  (spit (io/file root ".codewalk-parser.json")
        (json/write-str
         {"adapters"
          {"python"
           {"command" ["{python}"
                       "{dispatcher_root}/parser/orchestration/tests/fixtures/fake_adapter.py"
                       "{repo_root}"]
            "environment" {"FAKE_MODE" mode}}}})))

(defn- request [root language]
  {"path" (.getPath root) "language" language})

(defn- git! [root & args]
  (let [{:keys [exit out err]} (apply shell/sh (concat ["git" "-C" (.getPath root)] args))]
    (when-not (zero? exit)
      (throw (ex-info (str "Git fixture command failed: " err) {:args args})))
    (clojure.string/trim out)))

(defn- revision-repo []
  (let [root (.toFile (java.nio.file.Files/createTempDirectory
                       (.toPath (io/file (System/getProperty "user.dir") "test" "codewalk"))
                       (str ".revision-fixture-" (java.util.UUID/randomUUID))
                       (make-array java.nio.file.attribute.FileAttribute 0)))]
    (spit (io/file root "main.py") "def hello():\n    return 1\n")
    (write-config! root "normal")
    (git! root "init" "-q")
    (git! root "config" "user.email" "test@example.com")
    (git! root "config" "user.name" "Codewalk Test")
    (git! root "add" ".")
    (git! root "commit" "-qm" "initial")
    (let [first (git! root "rev-parse" "HEAD")]
      (spit (io/file root "main.py") "def hello():\n    return 2\n")
      (git! root "add" "main.py")
      (git! root "commit" "-qm" "change")
      (let [second (git! root "rev-parse" "HEAD")]
        (spit (io/file root "added.py") "def added():\n    return 3\n")
        (git! root "add" "added.py")
        (git! root "commit" "-qm" "add")
        (let [added (git! root "rev-parse" "HEAD")]
          (git! root "mv" "added.py" "renamed.py")
          (git! root "commit" "-qm" "rename")
          (let [renamed (git! root "rev-parse" "HEAD")]
            (git! root "rm" "-q" "main.py")
            (git! root "commit" "-qm" "delete")
            (let [deleted (git! root "rev-parse" "HEAD")]
              (write-config! root "timeout")
              (git! root "add" ".codewalk-parser.json")
              (git! root "commit" "-qm" "adapter timeout")
              {:root root
               :first first
               :second second
               :added added
               :renamed renamed
               :deleted deleted
               :failure (git! root "rev-parse" "HEAD")})))))))

(defn- remove-tree! [file]
  (doseq [entry (reverse (file-seq file))]
    (.delete ^java.io.File entry)))

(defn- nested-workspace []
  (let [parent (.toPath (io/file (System/getProperty "user.dir") "test" "codewalk"))
        root (.toFile (java.nio.file.Files/createTempDirectory
                       parent
                       (str ".nested-workspace-" (java.util.UUID/randomUUID))
                       (make-array java.nio.file.attribute.FileAttribute 0)))]
    (spit (io/file root "main.py") "def hello():\n    return 1\n")
    (write-config! root "normal")
    root))

(deftest capabilities-report-detection-and-runtime-state
  (let [root (temp-repo)
        result (parser/capabilities "." "." (.getPath root) nil)
        python (first (filter #(= "python" (get % "name")) (get result "adapters")))]
    (is (= true (get result "ok")))
    (is (= ["python"] (get result "languages")))
    (is (= true (get python "detected")))
    (is (contains? python "commandAvailable"))
    (is (contains? python "unavailableReasons"))))

(deftest explicit-and-auto-analysis-return-stable-envelope
  (let [root (temp-repo)]
    (doseq [request-body [(request root "auto")
                          (assoc (request root "py") "includeIr" true)]]
      (let [result (parser/analyze "." "." request-body)]
        (is (= true (get result "ok")))
        (is (= "python" (get result "language")))
        (is (= "complete" (get result "status")))
        (is (= 2 (get-in result ["graph" "stats" "nodes"])))
        (is (map? (get result "ir")))
        (is (not (contains? result "revision")))))))

(deftest clients-can-omit-the-full-ir-payload
  (let [root (temp-repo)
        result (parser/analyze "." "." (assoc (request root "python")
                                             "includeIr" false))]
    (is (= true (get result "ok")))
    (is (map? (get result "graph")))
    (is (not (contains? result "ir")))))

(deftest parser-output-limit-remains-256-mib
  (is (= (* 256 1024 1024)
         (var-get (ns-resolve 'codewalk.parser 'max-output-bytes)))))

(deftest nested-working-tree-preserves-analysis-root-and-config
  (let [root (nested-workspace)]
    (try
      (let [capabilities (parser/capabilities "." "." (.getPath root) nil)
            explicit (parser/analyze "." "." (request root "python"))
            automatic (parser/analyze "." "." (request root "auto"))]
        (is (= (.getPath root) (get capabilities "path")))
        (is (= ["python"] (get capabilities "languages")))
        (is (= "python" (get explicit "language")))
        (is (= "python" (get automatic "language")))
        (is (= "complete" (get explicit "status")))
        (is (= "complete" (get automatic "status"))))
      (try
        (parser/analyze "." "." (assoc (request root "rust") "language" "rust"))
        (is false "expected unsupported language")
        (catch clojure.lang.ExceptionInfo error
          (is (= "UNSUPPORTED_LANGUAGE" (:code (ex-data error))))
          (is (= 400 (:status (ex-data error))))))
      (write-config! root "nonzero-partial")
      (let [partial (parser/analyze "." "." (request root "python"))]
        (is (= "partial" (get partial "status")))
        (is (= 1 (count (get partial "diagnostics")))))
      (finally
        (remove-tree! root)))))

(deftest archived-revision-analyzes-requested-subpath
  (let [repo (io/file (System/getProperty "user.dir"))
        target (io/file repo "parser" "python")
        cache (io/file (.getParentFile repo) ".codewalk-revision-test-cache")
        old-cache (System/getProperty "codewalk.cache.dir")
        commit (git! repo "rev-parse" "HEAD")]
    (try
      (System/setProperty "codewalk.cache.dir" (.getPath cache))
      (let [result (parser/analyze "." "." {"path" (.getPath target)
                                            "language" "python"
                                            "commit" commit})]
        (is (= true (get result "ok")))
        (is (= "python" (get result "language")))
        (is (= commit (get-in result ["revision" "commit"])))
        (is (= (.getPath target) (get-in result ["graph" "repo" "root"])))
        (is (pos? (get-in result ["graph" "stats" "nodes"]))))
      (finally
        (if old-cache
          (System/setProperty "codewalk.cache.dir" old-cache)
          (System/clearProperty "codewalk.cache.dir"))
        (remove-tree! cache)))))

(deftest recoverable-diagnostics-remain-success
  (let [root (temp-repo)]
    (write-config! root "nonzero-partial")
    (let [result (parser/analyze "." "." (request root "python"))]
      (is (= true (get result "ok")))
      (is (= "partial" (get result "status")))
      (is (= 1 (count (get result "diagnostics")))))))

(deftest parser-failures-have-actionable-codes
  (testing "missing command"
    (let [root (temp-repo)]
      (spit (io/file root ".codewalk-parser.json")
            (json/write-str {"adapters" {"python" {"command" ["not-a-real-parser-runtime"]}}}))
      (try
        (parser/analyze "." "." (request root "python"))
        (is false "expected missing command")
        (catch clojure.lang.ExceptionInfo error
          (is (= "MISSING_COMMAND" (:code (ex-data error))))
          (is (= 503 (:status (ex-data error))))))))
  (testing "timeout"
    (let [root (temp-repo)]
      (write-config! root "timeout")
      (try
        (parser/analyze "." "." (assoc (request root "python") "timeoutSeconds" 0.1))
        (is false "expected timeout")
        (catch clojure.lang.ExceptionInfo error
          (is (= "ADAPTER_TIMEOUT" (:code (ex-data error))))
          (is (= 504 (:status (ex-data error))))))))
  (testing "malformed output"
    (let [root (temp-repo)]
      (write-config! root "malformed")
      (try
        (parser/analyze "." "." (request root "python"))
        (is false "expected malformed output")
        (catch clojure.lang.ExceptionInfo error
          (is (= "MALFORMED_JSON" (:code (ex-data error))))
          (is (= 502 (:status (ex-data error))))))))
  (testing "fatal adapter state"
    (let [root (temp-repo)]
      (write-config! root "fatal")
      (try
        (parser/analyze "." "." (request root "python"))
        (is false "expected fatal adapter error")
        (catch clojure.lang.ExceptionInfo error
          (is (= "ADAPTER_FATAL" (:code (ex-data error))))
          (is (= 502 (:status (ex-data error)))))))))

(deftest invalid-request-is-rejected
  (testing "unsupported language"
    (try
      (parser/analyze "." "." {"path" "/tmp" "language" "rust"})
      (is false "expected unsupported language")
      (catch clojure.lang.ExceptionInfo error
        (is (= "UNSUPPORTED_LANGUAGE" (:code (ex-data error))))
        (is (= 400 (:status (ex-data error)))))))
  (testing "missing path"
    (try
      (parser/analyze "." "." {"language" "auto"})
      (is false "expected invalid path")
      (catch clojure.lang.ExceptionInfo error
        (is (= "INVALID_PATH" (:code (ex-data error))))
        (is (= 400 (:status (ex-data error))))))))

(deftest revision-analysis-is-backward-compatible-and-stable
  (let [{:keys [root first second]} (revision-repo)]
    (try
      (let [revision-request (assoc (request root "python")
                                    "commit" second
                                    "previousCommit" first)
            initial (parser/analyze "." "." (assoc (request root "python") "commit" first))
            result (parser/analyze "." "." revision-request)
            repeated (parser/analyze "." "." revision-request)
            graph (get result "graph")
            revision (get result "revision")]
        (is (= true (get result "ok")))
        (is (= "python" (get result "language")))
        (is (= "incremental-map" (get revision "mode")))
        (is (= second (get revision "commit")))
        (is (= first (get revision "parentCommit")))
        (is (= 1 (count (get-in graph ["history" "commits"]))))
        (is (= (.getPath root) (get-in graph ["repo" "root"])))
        (is (= (set (map #(get % "id") (get-in initial ["graph" "nodes"])))
               (set (map #(get % "id") (get-in graph ["nodes"])))))
        (is (= (get-in result ["graph" "nodes"])
               (get-in repeated ["graph" "nodes"])))
        (is (= "cached" (get-in repeated ["revision" "mode"]))))
      (finally
        (remove-tree! root)))))

(deftest graph-only-revision-cache-preserves-default-ir
  (let [{:keys [root first second]} (revision-repo)]
    (try
      (history/clear-cache!)
      (let [graph-request (assoc (request root "python")
                                 "commit" second
                                 "previousCommit" first
                                 "includeIr" false)
            graph-only (parser/analyze "." "." graph-request)
            cached-graph (parser/analyze "." "." graph-request)
            complete (parser/analyze "." "."
                                     (assoc graph-request "includeIr" true))]
        (is (not (contains? graph-only "ir")))
        (is (= "cached" (get-in cached-graph ["revision" "mode"])))
        (is (map? (get complete "ir"))))
      (finally
        (history/clear-cache!)
        (remove-tree! root)))))

(deftest revision-metadata-covers-add-delete-and-rename
  (let [{:keys [root added renamed deleted]} (revision-repo)]
    (try
      (let [added-metadata (history/commit-metadata (.getPath root) added)
            renamed-metadata (history/commit-metadata (.getPath root) renamed)
            deleted-metadata (history/commit-metadata (.getPath root) deleted)]
        (is (= ["added.py"] (get added-metadata "addedFiles")))
        (is (= [{"from" "added.py" "to" "renamed.py"}]
               (get renamed-metadata "renamedFiles")))
        (is (= ["main.py"] (get deleted-metadata "deletedFiles"))))
      (finally
        (remove-tree! root)))))

(deftest revision-metadata-recurses-to-exact-files
  (let [{:keys [root]} (revision-repo)]
    (try
      (let [nested (io/file root "frontend" "src")]
        (.mkdirs nested)
        (spit (io/file nested "changed.ts") "export const changed = 1;\n")
        (spit (io/file nested "untouched.ts") "export const untouched = 1;\n")
        (git! root "add" ".")
        (git! root "commit" "-qm" "add nested files")
        (spit (io/file nested "changed.ts") "export const changed = 2;\n")
        (git! root "add" ".")
        (git! root "commit" "-qm" "change one nested file")
        (let [commit (git! root "rev-parse" "HEAD")
              metadata (history/commit-metadata (.getPath root) commit)
              nodes [{"id" "changed"
                      "kind" "namespace"
                      "file" "frontend/src/changed.ts"
                      "row" 1
                      "endRow" 1}
                     {"id" "untouched"
                      "kind" "namespace"
                      "file" "frontend/src/untouched.ts"
                      "row" 1
                      "endRow" 1}]
              mapped (history/changed-elements metadata nodes [])]
          (is (= ["frontend/src/changed.ts"] (get metadata "changedFiles")))
          (is (= ["changed"] (get mapped "changedNodeIds")))))
      (finally
        (remove-tree! root)))))

(deftest failed-revision-keeps-a-prior-successful-cache-entry
  (let [{:keys [root first second failure]} (revision-repo)]
    (try
      (let [good (assoc (request root "python")
                        "commit" second
                        "previousCommit" first)]
        (is (= true (get (parser/analyze "." "." good) "ok")))
        (try
          (parser/analyze "." "." (assoc (request root "python")
                                         "commit" failure
                                         "timeoutSeconds" 0.1))
          (is false "expected adapter timeout")
          (catch clojure.lang.ExceptionInfo error
            (is (= "ADAPTER_TIMEOUT" (:code (ex-data error))))))
        (is (= "cached"
               (get-in (parser/analyze "." "." good) ["revision" "mode"]))))
      (finally
        (remove-tree! root)))))

(deftest revision-refs-and-non-git-errors-are-structured
  (let [{:keys [root]} (revision-repo)]
    (try
      (testing "missing ref"
        (try
          (parser/analyze "." "." (assoc (request root "python") "commit" "does-not-exist"))
          (is false "expected missing commit")
          (catch clojure.lang.ExceptionInfo error
            (is (= "COMMIT_NOT_FOUND" (:code (ex-data error))))
            (is (= 404 (:status (ex-data error)))))))
      (testing "non-Git repository"
        (let [plain (io/file "/var")]
          (try
            (parser/analyze "." "." (assoc (request plain "python") "commit" "HEAD"))
            (is false "expected non-Git error")
            (catch clojure.lang.ExceptionInfo error
              (is (= "NOT_GIT_REPOSITORY" (:code (ex-data error))))
              (is (= 400 (:status (ex-data error))))))))
      (finally
        (remove-tree! root)))))

(deftest language-neutral-history-maps-nodes-and-edges-deterministically
  (let [metadata {"commit" "abc"
                  "changedFiles" ["src/service.py"]
                  "addedFiles" ["src/new.ts"]
                  "deletedFiles" ["src/removed.cs"]
                  "renamedFiles" [{"from" "src/old.ts" "to" "src/new.ts"}]
                  "changed-ranges" {"src/service.py" [[2 2]]}}
        nodes [{"id" "node-python-changed" "file" "src/service.py" "row" 2 "endRow" 2}
               {"id" "node-python-unchanged" "file" "src/service.py" "row" 5 "endRow" 5}
               {"id" "node-ts-added" "file" "src/new.ts" "row" 1 "endRow" 1}]
        edges [{"id" "edge-python"
                "evidence" [{"file" "src/service.py" "row" 2 "endRow" 2}]}
               {"id" "edge-unchanged"
                "evidence" [{"file" "src/service.py" "row" 5 "endRow" 5}]}]
        result (history/changed-elements metadata nodes edges)]
    (is (= ["node-python-changed"] (get result "changedNodeIds")))
    (is (= ["node-ts-added"] (get result "addedNodeIds")))
    (is (= ["edge-python"] (get result "changedEdgeIds")))
    (is (not (contains? result "changed-ranges")))))

(deftest revision-cache-is-bounded
  (history/clear-cache!)
  (doseq [index (range 30)]
    (history/cache! "/var/empty" "python" (str "commit-" index) {"index" index}))
  (is (<= (count (history/cache-keys)) 12))
  (history/clear-cache!))
