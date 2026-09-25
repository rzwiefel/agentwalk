(ns codewalk.main
  (:require [clojure.java.io :as io]
            [clojure.java.shell :as shell]
            [clojure.string :as str]
            [codewalk.analyzer :as analyzer]
            [codewalk.server :as server])
  (:import [java.security SecureRandom]
           [java.util Base64]
           [java.nio.file Files]
           [java.nio.file.attribute FileAttribute PosixFilePermissions]))

(def ^:private index-flags
  #{"--repo-root" "--out" "--without-external" "--history" "--history-limit"})

(def ^:private serve-flags
  #{"--repo-root" "--port" "--activity-token" "--activity-origins"
    "--activity-capture" "--activity-log-dir"})

(defn- unknown-flag! [arg]
  (throw (ex-info (str "Unknown flag: " arg)
                  {:usage-error true :exit-code 2 :arg arg})))

(defn- parse-args [known-flags args]
  (loop [remaining args positional [] options {}]
    (if (empty? remaining)
      {:paths positional :options options}
      (let [[arg & more] remaining]
        (cond
          (and (str/starts-with? arg "--") (not (contains? known-flags arg)))
          (unknown-flag! arg)

          (= arg "--without-external")
          (recur more positional (assoc options :include-external? false))

          (= arg "--history")
          (recur more positional (assoc options :include-history? true))

          (str/starts-with? arg "--")
          (if-let [value (first more)]
            (recur (rest more) positional
                   (assoc options (keyword (subs arg 2)) value))
            (throw (ex-info (str "Missing value for " arg) {:arg arg})))

          :else
          (recur more (conj positional arg) options))))))

(defn- canonical-path [path]
  (str (.getCanonicalFile (io/file path))))

(defn- git-root [path]
  (let [{:keys [exit out]} (shell/sh "git" "-C" path "rev-parse" "--show-toplevel")]
    (when (zero? exit) (str/trim out))))

(defn- default-repo-root [path]
  (or (git-root path)
      (let [file (io/file path)]
        (canonical-path (if (.isDirectory file) file (.getParentFile file))))))

(defn- usage []
  (println "usage: clojure -M:run index <path>... [--repo-root DIR] [--out FILE] [--without-external] [--history] [--history-limit N]")
  (println "       clojure -M:run serve [--repo-root DIR] [--port PORT] [--activity-token TOKEN] [--activity-origins LIST] [--activity-capture BOOL] [--activity-log-dir DIR]")
  (println)
  (println "  Index Clojure source paths into a Codewalk graph JSON file.")
  (println "  Start the local API for live repository and Git history exploration."))

(defn- new-activity-token
  "Generate a random activity token in the same format as
  codewalk.activity's private new-token: 32 SecureRandom bytes, URL-safe
  base64 encoded."
  []
  (let [bytes (byte-array 32)]
    (.nextBytes (SecureRandom.) bytes)
    (.encodeToString (Base64/getUrlEncoder) bytes)))

(defn- default-activity-token-file []
  (io/file (System/getProperty "user.home") ".codewalk" "activity" "token"))

(defn- ensure-activity-token-file!
  "Reuse or create the activity token file exactly the way scripts/dev-live.sh
  does: a 0700 directory containing a 0600 file, reused as-is when non-blank.
  Returns {:path :token}; the token value must never be printed."
  [^java.io.File file]
  (let [dir (.getParentFile file)]
    (Files/createDirectories (.toPath dir) (make-array FileAttribute 0))
    (Files/setPosixFilePermissions (.toPath dir)
                                   (PosixFilePermissions/fromString "rwx------"))
    (let [existing (when (.isFile file) (str/trim (slurp file)))]
      (if-not (str/blank? existing)
        {:path (str file) :token existing}
        (let [token (new-activity-token)]
          (spit file (str token "\n"))
          (Files/setPosixFilePermissions (.toPath file)
                                         (PosixFilePermissions/fromString "rw-------"))
          {:path (str file) :token token})))))

(defn- run-index [{:keys [paths options]}]
  (if (empty? paths)
    (do (usage) 1)
    (let [absolute-paths (mapv canonical-path paths)
          repo-root (canonical-path (or (:repo-root options)
                                        (default-repo-root (first absolute-paths))))
          output (or (:out options) "public/graph.json")
          graph (analyzer/analyze {:paths absolute-paths
                                   :repo-root repo-root
                                   :include-external? (get options :include-external? true)
                                   :include-history? (get options :include-history? false)
                                   :history-limit (some-> (:history-limit options) parse-long)})]
      (analyzer/write-graph! graph output)
      (println "Wrote" output)
      (doseq [[key value] (:stats graph)]
        (println (format "  %-16s %s" key value)))
      0)))

(defn- run-serve [{:keys [options]}]
  (let [port (some-> (:port options) parse-long)
        supplied-token (or (System/getenv "CODEWALK_ACTIVITY_TOKEN")
                           (:activity-token options))
        activity-token (if supplied-token
                         supplied-token
                         (let [{:keys [path token]}
                               (ensure-activity-token-file!
                                (default-activity-token-file))]
                           (println (str "Activity token file: " path))
                           token))
        activity-origins-value (or (System/getenv "CODEWALK_ACTIVITY_ORIGINS")
                                   (:activity-origins options))
        activity-origins (when activity-origins-value
                           (->> (str/split activity-origins-value #",")
                                (map str/trim)
                                (remove str/blank?)
                                set))
        activity-capture-value (or (System/getenv "CODEWALK_ACTIVITY_CAPTURE")
                                   (:activity-capture options))
        activity-capture? (when activity-capture-value
                            (case (str/lower-case activity-capture-value)
                              ("1" "true" "yes" "on") true
                              ("0" "false" "no" "off") false
                              (throw (ex-info
                                      "Activity capture must be true or false."
                                      {:usage-error true :exit-code 2}))))
        activity-log-dir (or (System/getenv "CODEWALK_ACTIVITY_LOG_DIR")
                             (:activity-log-dir options))
        server (server/start! {:port (or port 4180)
                               :repo-root (:repo-root options)
                               :activity-token activity-token
                               :activity-origins activity-origins
                               :activity-capture? activity-capture?
                               :activity-log-dir activity-log-dir})]
    (server/wait! server)
    0))

(defn -main [& args]
  (let [[command & rest-args] args]
    (try
      (case command
        "index" (run-index (parse-args index-flags rest-args))
        "serve" (run-serve (parse-args serve-flags rest-args))
        (do (usage) (if command 1 0)))
    (catch clojure.lang.ExceptionInfo error
      (binding [*out* *err*]
        (println (.getMessage error))
        (when (:usage-error (ex-data error))
          (usage)))
      (if-let [exit-code (:exit-code (ex-data error))]
        (System/exit exit-code)
        1))
    (finally
      ;; clojure.java.shell/sh uses agent-backed stream readers; stop those
      ;; readers when the one-shot index command has finished.
      (when (= command "index")
        (shutdown-agents))))))
