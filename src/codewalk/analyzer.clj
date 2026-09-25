(ns codewalk.analyzer
  "Deterministic clj-kondo analysis -> Codewalk graph JSON.

  The transport graph keeps namespace/var identities flat and portable for
  the visualizer."
  (:require [clj-kondo.core :as k]
            [clojure.data.json :as json]
            [clojure.java.io :as io]
            [clojure.java.shell :as shell]
            [clojure.string :as str]))

(defn- canonical-path [path]
  (str (.getCanonicalFile (io/file path))))

(defn- source-file? [file]
  (and (.isFile ^java.io.File file)
       (re-find #"\.(?:clj|cljs|cljc)$" (.getName ^java.io.File file))
       (not (re-find #"/(?:\.git|node_modules|target|dist|\.cpcache)/"
                     (canonical-path file)))))

(def ^:private ignored-directory-names
  #{".git" "node_modules" "target" "dist" ".cpcache"})

(defn- source-files [file]
  (if (.isDirectory ^java.io.File file)
    (if (contains? ignored-directory-names (.getName ^java.io.File file))
      []
      (mapcat source-files (or (seq (.listFiles ^java.io.File file)) [])))
    (if (source-file? file) [file] [])))

(defn source-paths
  "Return source files that clj-kondo can lint from a repository root."
  [repo-root]
  (->> (source-files (io/file repo-root))
       (map canonical-path)
       sort
       vec))

(defn- text [value]
  (when (some? value) (str value)))

(defn- node-id [kind name]
  (str kind ":" name))

(defn- namespace-name [value]
  (text value))

(defn- var-fqn [namespace-name name]
  (str namespace-name "/" name))

(defn- relative-file [repo-root filename]
  (when filename
    (let [root (canonical-path repo-root)
          file (canonical-path filename)
          prefix (str root "/")]
      (if (str/starts-with? file prefix)
        (subs file (count prefix))
        file))))

(defn- base-node [id kind label]
  {:id id :kind kind :label label})

(defn- span-contains?
  [row col [start-row start-col end-row end-col]]
  (and (or (> row start-row)
           (and (= row start-row) (>= col start-col)))
       (or (< row end-row)
           (and (= row end-row) (<= col end-col)))))

(defn- ns-spans-by-file [analysis]
  (reduce (fn [spans {:keys [filename row col end-row end-col]}]
            (update spans filename (fnil conj []) [row col end-row end-col]))
          {}
          (:namespace-definitions analysis)))

(defn- reader-keyword?
  [spans-by-file {:keys [filename row col keys-destructuring-ns-modifier]}]
  (or keys-destructuring-ns-modifier
      (some #(span-contains? row col %)
            (get spans-by-file filename))))

(defn- printed-keyword [{:keys [ns name]}]
  (if ns (str ":" ns "/" name) (str ":" name)))

(defn- namespace-nodes [analysis repo-root]
  (let [definitions (into {}
                          (keep (fn [definition]
                                  (when-let [name (namespace-name (:name definition))]
                                    [name definition])))
                          (:namespace-definitions analysis))
        referenced (into #{} (keep namespace-name)
                         (concat (keys definitions)
                                 (map :from (:namespace-usages analysis))
                                 (map :to (:namespace-usages analysis))
                                 (map :ns (:var-definitions analysis))
                                 (map :from (:var-usages analysis))
                                 (map :to (:var-usages analysis))))]
    (map (fn [name]
           (let [definition (get definitions name)]
             (cond-> (assoc (base-node (node-id "namespace" name) "namespace" name)
                            :namespace name
                            :external (nil? definition))
               definition (assoc :file (relative-file repo-root (:filename definition))
                                 :row (:row definition)
                                 :col (:col definition)
                                 :doc (:doc definition)))))
         (sort referenced))))

(defn- var-node [repo-root definition]
  (let [{:keys [ns name filename row col end-row end-col private macro deprecated doc
                fixed-arities varargs-min-arity arglist-strs]} definition
        namespace-name (text ns)
        name (text name)
        fqn (var-fqn namespace-name name)]
    (cond-> (assoc (base-node (node-id "var" fqn) "var" name)
                   :namespace namespace-name
                   :fqn fqn
                   :external false
                   :file (relative-file repo-root filename)
                   :row row
                   :col col
                   :endRow end-row
                   :endCol end-col)
      private (assoc :private true)
      macro (assoc :macro true)
      deprecated (assoc :deprecated true)
      doc (assoc :doc doc)
      (seq fixed-arities) (assoc :arities (vec (sort fixed-arities)))
      varargs-min-arity (assoc :varargsMinArity varargs-min-arity)
      (seq arglist-strs) (assoc :arglists (vec arglist-strs)))))

(defn- external-var-node [[namespace-name name]]
  (let [fqn (var-fqn namespace-name name)]
    (assoc (base-node (node-id "var" fqn) "var" name)
           :namespace namespace-name :fqn fqn :external true)))

(defn- edge-occurrence-sort-key [edge]
  [(or (:file edge) "")
   (or (:row edge) Long/MAX_VALUE)
   (or (:col edge) Long/MAX_VALUE)
   (or (:end-row edge) Long/MAX_VALUE)
   (or (:end-col edge) Long/MAX_VALUE)])

(defn- evidence-for-edge [edge occurrence-index]
  (cond-> {:source (:source edge)
           :occurrenceIndex occurrence-index}
    (:file edge) (assoc :file (:file edge))
    (and (some? (:row edge)) (some? (:col edge)))
    (assoc :row (:row edge)
           :col (:col edge)
           :start {"line" (:row edge) "column" (:col edge)})
    (and (some? (:end-row edge)) (some? (:end-col edge)))
    (assoc :end {"line" (:end-row edge) "column" (:end-col edge)})))

(defn- dedupe-edges [edges]
  (->> edges
       (group-by (juxt :kind :source :target))
       (map (fn [[_ occurrences]]
              (let [occurrences (vec (sort-by edge-occurrence-sort-key occurrences))
                    edge (first occurrences)]
                (assoc edge
                       :occurrenceCount (count occurrences)
                       :evidence (mapv evidence-for-edge occurrences (range))))))
       (sort-by :id)
       vec))

(defn- require-edges [analysis repo-root include-external? defined-names]
  (keep (fn [{:keys [from to filename row col]}]
          (let [source (namespace-name from)
                target (namespace-name to)]
            (when (and source target
                       (or include-external? (contains? defined-names target)))
              {:id (str "requires:" source "->" target)
               :kind "requires"
               :source (node-id "namespace" source)
               :target (node-id "namespace" target)
               :file (relative-file repo-root filename) :row row :col col})))
        (:namespace-usages analysis)))

(defn- call-data [analysis repo-root include-external? project-vars]
  (reduce (fn [{:keys [edges external-vars] :as result}
               {:keys [from from-var to name filename row col]}]
            (let [source-ns (namespace-name from)
                  source-var (text from-var)
                  target-ns (namespace-name to)
                  target-var (text name)
                  source-key [source-ns source-var]
                  target-key [target-ns target-var]
                  source (when (and source-ns source-var)
                           (node-id "var" (var-fqn source-ns source-var)))
                  target (when (and target-ns target-var)
                           (node-id "var" (var-fqn target-ns target-var)))
                  target-project? (contains? project-vars target-key)]
              (if (and source target (contains? project-vars source-key)
                       (or target-project? include-external?))
                (let [edge {:id (str "calls:" source "->" target)
                            :kind "calls" :source source :target target
                            :file (relative-file repo-root filename) :row row :col col}]
                  (cond-> (update-in result [:edges [source target]] (fnil conj []) edge)
                    (not target-project?) (update :external-vars conj target-key)))
                result)))
          {:edges {} :external-vars #{}}
          (:var-usages analysis)))

(defn- keyword-data [analysis repo-root code-namespaces]
  (let [spans-by-file (ns-spans-by-file analysis)
        keywords (remove #(reader-keyword? spans-by-file %) (:keywords analysis))
        grouped (group-by printed-keyword keywords)
        nodes (map (fn [[printed usages]]
                     (let [first-use (first usages)]
                       (assoc (base-node (node-id "keyword" printed) "keyword" printed)
                              :keywordQualifier (text (:ns first-use))
                              :qualifier (text (:ns first-use))
                              :lexicalNamespaces (->> usages
                                                      (keep #(namespace-name (:from %)))
                                                      distinct
                                                      sort
                                                      vec)
                              :namespace (when (contains? code-namespaces (text (:ns first-use)))
                                           (text (:ns first-use)))
                              :external false
                              :usageCount (count usages)
                              :file (relative-file repo-root (:filename first-use))
                              :row (:row first-use) :col (:col first-use))))
                   grouped)
        edges (keep (fn [usage]
                      (let [printed (printed-keyword usage)
                            target (node-id "keyword" printed)
                            source-ns (namespace-name (:from usage))
                            source-var (text (:from-var usage))
                            source (when source-ns
                                     (if source-var
                                       (node-id "var" (var-fqn source-ns source-var))
                                       (node-id "namespace" source-ns)))]
                        (when source
                          {:id (str "mentions:" source "->" target)
                           :kind "mentions" :source source :target target
                           :file (relative-file repo-root (:filename usage))
                           :row (:row usage) :col (:col usage)})))
                    keywords)]
    {:nodes (vec (sort-by :id nodes)) :edges (vec edges)}))

(defn- dedupe-nodes
  [nodes]
  (->> nodes
       (reduce (fn [result node] (assoc result (:id node) node)) {})
       vals
       (sort-by :id)
       vec))

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


(defn- git-file-changes
  [repo-root hash]
  (let [{:keys [exit out]} (shell/sh "git" "-C" repo-root "show" "--format="
                                      "--name-status" "--find-renames" hash)]
    (if (zero? exit)
      (reduce (fn [result line]
                (let [[status & paths] (str/split line #"\t")
                      file (last paths)]
                  (if (str/blank? file)
                    result
                    (-> result
                        (update :changed-files conj file)
                        (cond-> (= status "A") (update :added-files conj file))))))
              {:changed-files [] :added-files []}
              (remove str/blank? (str/split-lines out)))
      {:changed-files [] :added-files []})))

(defn- git-changed-ranges
  [repo-root hash]
  (let [{:keys [exit out]} (shell/sh "git" "-C" repo-root "show" "--format=" "--unified=0"
                                      "--find-renames" hash)]
    (if (zero? exit)
      (reduce (fn [result line]
                (if-let [[_ file] (re-find #"\+\+\+ b/(.+)" line)]
                  (assoc result :file file)
                  (if-let [[_ start count] (re-find #"@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@" line)]
                    (let [start (Long/parseLong start)
                          count (Long/parseLong (or count "1"))]
                      (if (and (:file result) (pos? count))
                        (update-in result [:ranges (:file result)] (fnil conj []) [start (+ start count -1)])
                        result))
                    result)))
              {:file nil :ranges {}}
              (str/split-lines out))
      {:file nil :ranges {}})))

(defn- git-path-renames
  "Return the repository's detected old-path -> new-path rename map.

  History is displayed against the current graph snapshot, so following Git's
  rename records lets an early commit still address the current node for a
  file that was renamed later (for example legacy_app -> current_app)."
  [repo-root]
  (let [{:keys [exit out]} (shell/sh "git" "-C" repo-root "log" "--all"
                                     "--name-status" "--find-renames" "--format=")]
    (if (zero? exit)
      (into {}
            (keep (fn [line]
                    (let [[status old-path new-path] (str/split line #"\t")]
                      (when (and (some? status)
                                 (str/starts-with? status "R")
                                 (not (str/blank? old-path))
                                 (not (str/blank? new-path)))
                        [old-path new-path]))))
            (remove str/blank? (str/split-lines out)))
      {})))

(defn- resolved-path
  [renames current-files path]
  (loop [path path seen #{}]
    (if (or (nil? path) (contains? current-files path) (contains? seen path))
      path
      (if-let [next-path (get renames path)]
        (recur next-path (conj seen path))
        path))))

(defn- git-history
  [repo-root limit]
  (let [{:keys [exit out]} (shell/sh "git" "-C" repo-root "log" "--reverse"
                                      "--format=%H%x1f%h%x1f%aI%x1f%an%x1f%s")]
    (when (zero? exit)
      (->> (str/split-lines out)
           (remove str/blank?)
           (take (or limit 200))
           (mapv (fn [line]
                   (let [[hash short-hash timestamp author message]
                         (str/split line #"\u001f" 5)
                         {:keys [changed-files added-files]} (git-file-changes repo-root hash)
                         {:keys [ranges]} (git-changed-ranges repo-root hash)]
                     {:id hash
                      :hash hash
                      :shortHash short-hash
                      :message message
                      :author author
                      :timestamp timestamp
                      :changedFiles (vec (distinct changed-files))
                      :addedFiles (vec (distinct added-files))
                      :changed-ranges ranges})))))))

(defn commit-metadata
  "Load one commit's metadata and changed-line information without analyzing code."
  [repo-root hash]
  (let [{:keys [exit out]} (shell/sh "git" "-C" repo-root "show" "-s"
                                      "--format=%H%x1f%h%x1f%aI%x1f%an%x1f%s" hash)]
    (when (zero? exit)
      (let [[commit short-hash timestamp author message]
            (str/split (str/trim out) #"\u001f" 5)
            {:keys [changed-files added-files]} (git-file-changes repo-root hash)
            {:keys [ranges]} (git-changed-ranges repo-root hash)]
        {:id commit
         :hash commit
         :shortHash short-hash
         :message message
         :author author
         :timestamp timestamp
         :changedFiles (vec (distinct changed-files))
         :addedFiles (vec (distinct added-files))
         :changed-ranges ranges}))))

(defn- path-matches?
  [file changed-file]
  (and file changed-file
       (or (= file changed-file)
           (str/starts-with? file (str changed-file "/")))))

(defn- node-file-changed?
  [file changed-files renames current-files]
  (and file
       (some #(path-matches? file (resolved-path renames current-files %))
             changed-files)))

(defn- line-overlaps?
  [row end-row [start end]]
  (let [node-end (or end-row row)]
    (and row node-end (<= start node-end) (<= row end))))

(defn- changed-ranges-for
  [file commit renames current-files]
  (mapcat (fn [[changed-file changed-ranges]]
            (when (path-matches? file (resolved-path renames current-files changed-file))
              changed-ranges))
          (:changed-ranges commit)))

(defn- node-changed?
  [node commit renames current-files]
  (let [file (:file node)
        ranges (changed-ranges-for file commit renames current-files)]
    (and file
         (or (some #(line-overlaps? (:row node) (:endRow node) %) ranges)
             (and (or (= "namespace" (:kind node)) (nil? (:row node)))
                  (node-file-changed? file (:changedFiles commit) renames current-files))))))

(defn- edge-changed?
  [edge commit renames current-files]
  (and (:file edge)
       (some #(line-overlaps? (:row edge) (:row edge) %)
             (changed-ranges-for (:file edge) commit renames current-files))))


(defn- history-with-node-ids
  [commits nodes edges renames current-files]
  (mapv (fn [commit]
          (-> commit
              (assoc :changedNodeIds
                     (->> nodes
                          (filter #(node-changed? % commit renames current-files))
                          (map :id)
                          vec)
                     :addedNodeIds
                     (->> nodes
                          (filter #(and (= "namespace" (:kind %))
                                        (node-file-changed? (:file %) (:addedFiles commit) renames current-files)))
                          (map :id)
                          vec)
                     :changedEdgeIds
                     (->> edges
                          (filter #(and (= "requires" (:kind %))
                                        (edge-changed? % commit renames current-files)))
                          (map :id)
                          vec))
              (dissoc :changed-ranges)))
        commits))

(defn changed-node-ids
  "Attach changed and added node IDs to one commit for its graph snapshot."
  [commit nodes]
  (first (history-with-node-ids [commit]
                                nodes
                                []
                                {}
                                (into #{} (keep :file nodes)))))

(defn changed-element-ids
  "Attach changed node and edge IDs to one commit for its graph snapshot."
  [commit nodes edges]
  (first (history-with-node-ids [commit]
                                nodes
                                edges
                                {}
                                (into #{} (keep :file nodes)))))

(defn analyze
  "Analyze absolute lint paths into a stable Codewalk graph map."
  [{:keys [paths repo-root include-external? include-history? history-limit]
    :or {include-external? true include-history? false history-limit 200}}]
  (let [repo-root (canonical-path repo-root)
        analysis (or (:analysis (k/run! {:lint paths
                                         :config {:output {:analysis {:keywords true
                                                                      :arglists true}}}}))
                    {})
        definitions (vec (:var-definitions analysis))
        project-vars (into #{} (map (juxt (comp text :ns) (comp text :name))) definitions)
        ns-nodes (vec (namespace-nodes analysis repo-root))
        var-nodes (vec (map #(var-node repo-root %) definitions))
        call-result (call-data analysis repo-root include-external? project-vars)
        external-var-nodes (map external-var-node (:external-vars call-result))
        keyword-result (keyword-data analysis repo-root
                                      (set (keep :namespace (remove :external ns-nodes))))
        all-nodes (concat ns-nodes var-nodes external-var-nodes (:nodes keyword-result))
        nodes (->> all-nodes
                   (filter #(or include-external? (not (:external %))))
                   dedupe-nodes)
        current-files (into #{} (keep :file nodes))
        node-ids (into #{} (map :id nodes))
        edges (->> (concat (require-edges analysis repo-root include-external?
                                          (set (map :namespace ns-nodes)))
                          (mapcat identity (vals (:edges call-result)))
                          (:edges keyword-result))
                   (filter (fn [edge]
                             (and (contains? node-ids (:source edge))
                                  (contains? node-ids (:target edge)))))
                   dedupe-edges)
        commits (when include-history? (git-history repo-root history-limit))
        renames (when include-history? (git-path-renames repo-root))
        history (when commits {:commits (history-with-node-ids commits nodes edges renames current-files)})]
    (cond-> {:formatVersion 2
             :generatedAt (str (java.time.Instant/now))
             :repo {"name" (.getName (io/file repo-root)) "root" repo-root}
             :nodes nodes
             :edges edges
             :stats (graph-stats nodes edges)}
      history (assoc :history history))))

(defn write-graph! [graph output]
  (let [output-file (io/file output)]
    (when-let [parent (.getParentFile output-file)] (.mkdirs parent))
    (spit output-file (json/write-str graph))
    output))
