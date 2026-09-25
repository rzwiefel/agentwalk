(ns codewalk.temporal
  "Pure aggregation helpers for temporal namespace coupling.

  These functions accept the maps emitted by codewalk.analyzer and do not
  inspect Git or mutate analyzer state. They are also useful to callers that
  already have normalized namespace observations."
  (:require [clojure.string :as str]))

(defn- text [value]
  (when (some? value)
    (let [value (str/trim (str value))]
      (when (seq value) value))))

(defn- sorted-distinct [values]
  (->> values
       (keep text)
       distinct
       sort
       vec))

(defn namespace-pair
  "Return a deterministic unordered pair, or nil for an invalid/self pair."
  [a b]
  (let [pair (sort (keep text [a b]))]
    (when (and (= 2 (count pair)) (not= (first pair) (second pair)))
      (vec pair))))

(defn- path-match? [changed known]
  (let [changed (some-> changed text (str/replace "\\" "/") (str/replace #"^\./+" ""))
        known (some-> known text (str/replace "\\" "/") (str/replace #"^\./+" ""))]
    (and changed known
         (or (= changed known)
             (str/ends-with? changed (str "/" known))
             (str/ends-with? known (str "/" changed))))))

(defn commit-file-observations
  "Map commit :changedFiles to namespaces.

  `file->namespaces` may be a map of file paths to collections of namespace
  names. Unknown files remain visible in :unmapped-files so callers can report
  partial coverage instead of treating the result as complete."
  [commits file->namespaces]
  (let [entries (sort-by key file->namespaces)]
    (mapv (fn [[index commit]]
            (let [files (sorted-distinct (concat (:changedFiles commit)
                                                 (:changed-files commit)))
                  matches (for [file files
                                [known namespaces] entries
                                :when (path-match? file known)]
                            [file namespaces])
                  mapped-files (set (map first matches))
                  namespaces (sorted-distinct (mapcat second matches))]
              {:hash (or (text (:hash commit)) (text (:id commit))
                         (str "commit-" index))
               :timestamp (or (text (:timestamp commit)) (text (:date commit)))
               :changed-files files
               :namespaces namespaces
               :unmapped-files (vec (remove mapped-files files))}))
          (map-indexed vector commits))))

(defn- normalize-observation [observation index]
  {:hash (or (text (:hash observation))
             (text (:id observation))
             (text (:commit-hash observation))
             (str "commit-" index))
   :namespaces (sorted-distinct (concat (:namespaces observation)
                                        (:changedNamespaces observation)
                                        (:changed-namespaces observation)))
   :changed-files (sorted-distinct (concat (:changedFiles observation)
                                           (:changed-files observation)))})

(defn aggregate-namespace-coupling
  "Aggregate normalized commit observations into unordered namespace pairs.

  Empty observations and duplicate hashes are ignored for pair counts.
  Returned counts are commit counts (not file counts), matching the TypeScript
  implementation used by the viewer."
  [observations]
  (let [observations (->> observations
                          (map-indexed (fn [index observation]
                                         (normalize-observation observation index)))
                          (remove #(empty? (:namespaces %)))
                          (reduce (fn [result observation]
                                    (if (some #(= (:hash %) (:hash observation)) result)
                                      result
                                      (conj result observation)))
                                  [])
                          vec)
        observable (count observations)
        namespace-counts (frequencies (mapcat :namespaces observations))
        pair-stats (reduce (fn [result {:keys [hash namespaces changed-files]}]
                             (reduce (fn [result pair]
                                       (let [key (str/join "\u001f" pair)]
                                         (update result key (fnil (fn [stats]
                                                                    (-> stats
                                                                        (update :co-change-count inc)
                                                                        (update :commit-hashes conj hash)
                                                                        (update :files into changed-files)))
                                                                  {:pair pair
                                                                   :co-change-count 0
                                                                   :commit-hashes #{}
                                                                   :files #{}}))))
                                     result
                                     (set (for [a namespaces
                                                b namespaces
                                                :let [pair (namespace-pair a b)]
                                                :when pair]
                                            pair))))
                           {}
                           observations)]
    (->> (vals pair-stats)
         (map (fn [{:keys [pair co-change-count commit-hashes files]}]
                (let [[a b] pair
                      a-count (get namespace-counts a 0)
                      b-count (get namespace-counts b 0)
                      support (if (pos? observable) (/ co-change-count observable) 0)
                      confidence-a->b (if (pos? a-count) (/ co-change-count a-count) 0)
                      confidence-b->a (if (pos? b-count) (/ co-change-count b-count) 0)
                      union (- (+ a-count b-count) co-change-count)
                      jaccard (if (pos? union) (/ co-change-count union) 0)
                      lift (if (and (pos? support) (pos? observable))
                             (/ support (* (/ a-count observable)
                                           (/ b-count observable)))
                             0)]
                  {:namespace-pair pair
                   :namespace-a a
                   :namespace-b b
                   :co-change-count co-change-count
                   :namespace-a-change-count a-count
                   :namespace-b-change-count b-count
                   :observable-commit-count observable
                   :support support
                   :confidence (max confidence-a->b confidence-b->a)
                   :confidence-a->b confidence-a->b
                   :confidence-b->a confidence-b->a
                   :jaccard jaccard
                   :lift lift
                   :supporting-commit-hashes (sort commit-hashes)
                   :supporting-files (sort files)})))
         (sort-by (juxt :namespace-a :namespace-b))
         vec)))

(def aggregate-temporal-coupling aggregate-namespace-coupling)
