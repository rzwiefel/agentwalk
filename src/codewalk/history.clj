(ns codewalk.history
  "Language-neutral Git revision, archive, cache, and graph-change helpers."
  (:require [clojure.java.io :as io]
            [clojure.java.shell :as shell]
            [clojure.string :as str])
  (:import [java.nio.file Files]
           [java.nio.file.attribute FileAttribute]
           [java.util UUID]))

(def ^:private max-archive-bytes (* 256 1024 1024))
(def ^:private max-cache-entries 12)
(def ^:private revision-cache (atom {}))

(defn- api-error [status code message details]
  (throw (ex-info message
                  (cond-> {:api-error true :status status :code code}
                    details (assoc :details details)))))

(defn- canonical [value]
  (str (.getCanonicalFile (io/file value))))

(defn- path-inside? [root candidate]
  (let [root (str (.toPath (.getCanonicalFile (io/file root))))
        candidate (str (.toPath (.getCanonicalFile (io/file candidate))))]
    (or (= root candidate)
        (str/starts-with? candidate (str root java.io.File/separator)))))

(defn- cache-root []
  (let [configured (or (System/getProperty "codewalk.cache.dir")
                       (System/getenv "CODEWALK_CACHE_DIR"))
        home (System/getProperty "user.home")
        root (canonical (or configured (io/file home ".cache" "codewalk" "revisions")))]
    root))

(defn clear-cache! []
  (reset! revision-cache {})
  nil)

(defn cache-keys []
  (keys @revision-cache))

(defn- cache-key [repo language commit]
  [(canonical repo) (or language "auto") commit])

(defn cached [repo language commit]
  (get @revision-cache (cache-key repo language commit)))

(defn- trim-cache! []
  (when (> (count @revision-cache) max-cache-entries)
    (let [keep (->> @revision-cache
                    (sort-by (fn [[_ value]] (:cached-at value)))
                    (take-last max-cache-entries)
                    (into {}))]
      (reset! revision-cache keep))))

(defn cache! [repo language commit value]
  (swap! revision-cache assoc (cache-key repo language commit)
         {:cached-at (System/nanoTime)
          :value value})
  (trim-cache!)
  value)

(defn cached-value [repo language commit]
  (some-> (cached repo language commit) :value))

(defn- git! [repo args]
  (let [{:keys [exit out err]} (apply shell/sh (concat ["git" "-C" repo] args))]
    (if (zero? exit)
      (str/trim out)
      (api-error 400 "GIT_FAILURE"
                 "Git could not read the requested repository revision."
                 {"command" (vec (concat ["git" "-C" repo] args))
                  "stderr" (str/trim err)
                  "exitCode" exit}))))

(defn repository-root
  "Return the canonical Git root or raise a structured non-Git error."
  [path]
  (let [candidate (canonical path)
        {:keys [exit out]} (shell/sh "git" "-C" candidate "rev-parse" "--show-toplevel")]
    (if (zero? exit)
      (canonical (str/trim out))
      (api-error 400 "NOT_GIT_REPOSITORY"
                 "Revision analysis requires a local Git repository."
                 {"path" candidate}))))

(defn repository-relative
  "Return PATH relative to the enclosing Git repository, or raise if outside it."
  [repo path]
  (let [repo (canonical repo)
        path (canonical path)
        repo-path (.toPath (io/file repo))
        path-path (.toPath (io/file path))]
    (when-not (or (= repo-path path-path)
                 (.startsWith path-path repo-path))
      (api-error 400 "INVALID_PATH"
                 "The requested analysis path is outside its Git repository."
                 {"repository" repo "path" path}))
    (let [relative (str (.normalize (.relativize repo-path path-path)))]
      (if (str/blank? relative) "." relative))))

(defn resolve-commit
  "Resolve a ref to a commit without allowing option injection."
  [repo ref]
  (let [ref (or (when-not (str/blank? ref) ref) "HEAD")]
    (when (or (> (count ref) 4096)
              (str/includes? ref "\u0000")
              (str/includes? ref "\n")
              (str/includes? ref "\r"))
      (api-error 400 "INVALID_COMMIT" "The Git ref is invalid." {"commit" ref}))
    (let [{:keys [exit out]} (shell/sh "git" "-C" repo "rev-parse" "--verify"
                                       "--end-of-options" (str ref "^{commit}"))]
      (if (zero? exit)
        (str/trim out)
        (api-error 404 "COMMIT_NOT_FOUND"
                   "That Git commit could not be resolved."
                   {"commit" ref})))))

(defn parent-commit [repo commit]
  (let [{:keys [exit out]} (shell/sh "git" "-C" repo "rev-parse" "--verify"
                                     "--end-of-options" (str commit "^"))]
    (when (zero? exit)
      (str/trim out))))

(defn- parse-name-status [output]
  (loop [tokens (vec (remove str/blank? (str/split output #"\u0000")))
         result {:changed-files [] :added-files [] :deleted-files [] :renamed-files []}]
    (if (empty? tokens)
      result
      (let [status (first tokens)
            kind (some-> status first)
            path-count (if (#{\R \C} kind) 2 1)
            paths (subvec tokens 1 (min (count tokens) (inc path-count)))
            from (when (= path-count 2) (first paths))
            to (if from (second paths) (first paths))]
        (if (or (str/blank? status) (empty? to))
          (recur (subvec tokens (min (count tokens) (inc path-count))) result)
          (recur (subvec tokens (min (count tokens) (inc path-count)))
                 (cond-> result
                   to (update :changed-files conj to)
                   (= kind \A) (update :added-files conj to)
                   (= kind \D) (update :deleted-files conj to)
                   (= kind \R) (update :renamed-files conj {"from" from "to" to}))))))))

(defn- diff-ranges [repo commit]
  (let [{:keys [exit out]} (shell/sh "git" "-C" repo "diff-tree" "-r" "--root" "-p"
                                     "--unified=0" "-M" "--format=" commit)]
    (if-not (zero? exit)
      {}
      (second
       (reduce (fn [[current ranges] line]
                 (if-let [[_ path] (re-find #"^\+\+\+ b/(.+)$" line)]
                   [path ranges]
                   (if-let [[_ start count] (re-find #"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@" line)]
                     (let [start (Long/parseLong start)
                           count (Long/parseLong (or count "1"))]
                       [current (if (and current (pos? count))
                                   (update ranges current (fnil conj [])
                                           [start (+ start count -1)])
                                   ranges)])
                     [current ranges])))
               [nil {}]
               (str/split-lines out))))))

(defn commit-metadata [repo commit]
  (let [{:keys [exit out]} (shell/sh "git" "-C" repo "show" "-s"
                                     "--format=%H%x1f%h%x1f%aI%x1f%an%x1f%s%x1f%P" commit)]
    (when-not (zero? exit)
      (api-error 404 "COMMIT_NOT_FOUND" "That Git commit could not be resolved."
                 {"commit" commit}))
    (let [[hash short-hash timestamp author message parents]
          (str/split (str/trim out) #"\u001f" 6)
          changes (parse-name-status
                 (git! repo ["diff-tree" "-r" "--root" "--no-commit-id" "--name-status" "-z"
                               "-M" "--format=" commit]))]
      (merge {"id" hash
              "hash" hash
              "shortHash" short-hash
              "timestamp" timestamp
              "author" author
              "message" message
              "changedFiles" (vec (sort (distinct (:changed-files changes))))
              "addedFiles" (vec (sort (distinct (:added-files changes))))
              "deletedFiles" (vec (sort (distinct (:deleted-files changes))))
              "renamedFiles" (vec (sort-by (juxt #(get % "from") #(get % "to"))
                                           (:renamed-files changes)))
              "changed-ranges" (diff-ranges repo commit)}
             (when-let [parent (first (remove str/blank? (str/split (or parents "") #"\s+")))]
               {"parentCommit" parent})))))

(defn- delete-tree! [directory]
  (doseq [file (reverse (file-seq directory))]
    (Files/deleteIfExists (.toPath ^java.io.File file))))

(defn with-archive
  "Archive COMMIT into a bounded cache location, call f with its root, clean up."
  ([repo commit f]
   (with-archive repo commit "." f))
  ([repo commit relative-root f]
   (let [repo (canonical repo)
         root (cache-root)]
    (when (path-inside? repo root)
      (api-error 503 "CACHE_LOCATION_INVALID"
                 "The revision scratch location must be outside the target repository."
                 {"repository" repo "cache" root}))
    (try
      (Files/createDirectories (.toPath (io/file root))
                               (make-array FileAttribute 0))
      (catch java.io.IOException error
        (api-error 503 "CACHE_LOCATION_UNAVAILABLE"
                   "The revision cache location could not be created."
                   {"path" root "cause" (.getMessage error)})))
    (let [directory (io/file root (str "revision-" (UUID/randomUUID)))
          archive (io/file root (str "archive-" (UUID/randomUUID) ".tar"))]
      (try
        (Files/createDirectory (.toPath directory) (make-array FileAttribute 0))
        (let [{:keys [exit err]} (apply shell/sh
                                        (concat ["git" "-C" repo "archive" "--format=tar"
                                                 "--output" (.getPath archive) commit]))]
          (when-not (zero? exit)
            (api-error 400 "ARCHIVE_FAILURE"
                       "Git could not archive the requested revision."
                       {"stderr" (str/trim err) "commit" commit}))
          (when (> (.length archive) max-archive-bytes)
            (api-error 413 "ARCHIVE_TOO_LARGE"
                       "The selected revision exceeds the archive size limit."
                       {"limitBytes" max-archive-bytes}))
          (let [{:keys [exit err]} (shell/sh "tar" "-xf" (.getPath archive)
                                             "-C" (.getPath directory))]
            (when-not (zero? exit)
              (api-error 400 "ARCHIVE_FAILURE"
                         "The selected revision could not be extracted."
                         {"stderr" (str/trim err) "commit" commit})))
          (let [analysis-root (io/file directory relative-root)]
            (when-not (.isDirectory analysis-root)
              (api-error 400 "INVALID_REPOSITORY"
                         "The selected revision does not contain the requested analysis root."
                         {"path" relative-root "commit" commit}))
            (f analysis-root)))
        (finally
          (try (Files/deleteIfExists (.toPath archive)) (catch java.io.IOException _ nil))
          (try (delete-tree! directory) (catch java.io.IOException _ nil))))))))

(defn- value [m key]
  (or (get m key) (get m (keyword key))))

(defn- path-matches? [node-file changed-file]
  (and node-file changed-file
       (or (= node-file changed-file)
           (str/starts-with? node-file (str changed-file "/")))))

(defn- renamed-path [renames path]
  (or (some (fn [rename]
              (when (= path (get rename "from"))
                (get rename "to")))
            renames)
      path))

(defn- path-prefixes [path]
  (loop [candidate path
         prefixes []]
    (if (str/blank? candidate)
      prefixes
      (let [separator (.lastIndexOf ^String candidate "/")]
        (recur (when (pos? separator)
                 (subs candidate 0 separator))
               (conj prefixes candidate))))))

(defn- line-overlaps? [row end-row ranges]
  (let [end-row (or end-row row)]
    (and (number? row) (number? end-row)
         (some (fn [[start end]] (and (<= start end-row) (<= row end))) ranges))))

(defn- evidence-items [edge]
  (let [evidence (value edge "evidence")]
    (if (seq evidence)
      evidence
      [edge])))

(defn- changed? [item {:keys [changed-files changed-ranges renames]}]
  (let [file (value item "file")
        target-file (renamed-path renames file)
        prefixes (path-prefixes target-file)
        matching-ranges (mapcat #(get changed-ranges %) prefixes)]
    (and target-file
         (if (seq matching-ranges)
           (or (line-overlaps? (value item "row")
                               (value item "endRow")
                               matching-ranges)
               (and (or (= "namespace" (value item "kind"))
                        (nil? (value item "row")))
                    (some changed-files prefixes)))
           (some changed-files prefixes)))))

(defn changed-elements
  "Attach deterministic node/edge IDs to one language-neutral commit record."
  [commit nodes edges]
  (let [change-context {:changed-files (set (value commit "changedFiles"))
                        :changed-ranges (value commit "changed-ranges")
                        :renames (value commit "renamedFiles")}
        added (set (value commit "addedFiles"))
        changed-node-ids (->> nodes
                              (filter #(changed? % change-context))
                              (map #(value % "id"))
                              sort
                              vec)
        added-node-ids (->> nodes
                            (filter #(some (fn [path]
                                             (path-matches? (value % "file") path))
                                           added))
                            (map #(value % "id"))
                            sort
                            vec)
        changed-edge-ids (->> edges
                              (filter #(some (fn [evidence] (changed? evidence change-context))
                                             (evidence-items %)))
                              (map #(value % "id"))
                              sort
                              vec)]
    (-> commit
        (assoc "changedNodeIds" changed-node-ids
               "addedNodeIds" added-node-ids
               "changedEdgeIds" changed-edge-ids
               "limitations" ["deletions are absent from the current graph"
                              "rename and overload edge cases may be ambiguous"
                              "adapters are fully reparsed; changed-file APIs are not used"
                              "generated/vendor changes may be noisy"
                              "shallow or missing Git commits limit history context"])
        (dissoc "changed-ranges"))))
