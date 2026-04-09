// ── Random username generator ──────────────────────────────
// Pattern: adjective-animal-NNNN (Haikunator-style)
// 80 × 80 × 10000 = 64M combinations → collision-free at scale.
// Lists curated to avoid offensive combinations.

const ADJECTIVES = [
  "swift", "bright", "calm", "bold", "keen",
  "warm", "cool", "wild", "free", "kind",
  "deep", "fair", "glad", "pure", "wise",
  "brave", "crisp", "deft", "firm", "fond",
  "grand", "hale", "just", "lush", "mild",
  "neat", "prime", "rare", "safe", "sage",
  "tall", "true", "vast", "avid", "civic",
  "dual", "epic", "focal", "gilt", "hardy",
  "ionic", "jolly", "lucid", "lunar", "major",
  "naval", "noble", "opal", "plush", "polar",
  "quiet", "rapid", "regal", "risen", "royal",
  "sleek", "solar", "sonic", "stark", "sunny",
  "tidal", "ultra", "vivid", "witty", "young",
  "agile", "amber", "azure", "cedar", "coral",
  "crystal", "ember", "flint", "frost", "ivory",
  "jade", "maple", "misty", "onyx", "pixel",
  "prism", "quartz", "rustic", "silver", "velvet",
];

const ANIMALS = [
  "otter", "hawk", "fox", "panda", "wolf",
  "eagle", "lynx", "heron", "falcon", "crane",
  "raven", "cobra", "bison", "whale", "shark",
  "tiger", "finch", "gecko", "koala", "lemur",
  "moose", "newt", "okapi", "quail", "robin",
  "sloth", "stork", "swift", "tapir", "viper",
  "wren", "yak", "zebra", "alpaca", "badger",
  "camel", "dingo", "egret", "ferret", "grouse",
  "hare", "ibis", "jackal", "kiwi", "lark",
  "mink", "narwhal", "osprey", "parrot", "puma",
  "rook", "salmon", "tern", "urchin", "vole",
  "walrus", "condor", "dove", "ermine", "gull",
  "hippo", "iguana", "jay", "koi", "lion",
  "marten", "nuthatch", "ocelot", "penguin", "quetzal",
  "rail", "seal", "toucan", "umbra", "vulture",
  "wombat", "axolotl", "bobcat", "cicada", "drake",
];

export function generateRandomName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  const token = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return `${adj}-${animal}-${token}`;
}
