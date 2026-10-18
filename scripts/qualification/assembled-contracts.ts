export const STAGES = ["component", "source", "installed", "platform", "provider", "assembled"] as const;
export type Stage = typeof STAGES[number];
export type SourcePin = { sha: string; tree: string };
export type Host = { platform: "darwin" | "linux" | "win32"; arch: "arm64" | "x64" };
export const HOSTS: readonly Host[] = [
  { platform: "darwin", arch: "arm64" }, { platform: "darwin", arch: "x64" },
  { platform: "linux", arch: "x64" }, { platform: "linux", arch: "arm64" }, { platform: "win32", arch: "x64" },
];
export const ENGINES = ["chromium", "firefox", "webkit"] as const;
export const FEATURES = [
  {
    "id": "F00",
    "dependencies": []
  },
  {
    "id": "F01",
    "dependencies": [
      "F00"
    ]
  },
  {
    "id": "F02",
    "dependencies": [
      "F00"
    ]
  },
  {
    "id": "F03",
    "dependencies": [
      "F02"
    ]
  },
  {
    "id": "F04",
    "dependencies": [
      "F03"
    ]
  },
  {
    "id": "F05",
    "dependencies": [
      "F01",
      "F04"
    ]
  },
  {
    "id": "F06",
    "dependencies": [
      "F04"
    ]
  },
  {
    "id": "F07",
    "dependencies": [
      "F01",
      "F02",
      "F04"
    ]
  },
  {
    "id": "F08",
    "dependencies": [
      "F05",
      "F07"
    ]
  },
  {
    "id": "F09",
    "dependencies": [
      "F00"
    ]
  },
  {
    "id": "F10",
    "dependencies": [
      "F00"
    ]
  },
  {
    "id": "F11",
    "dependencies": [
      "F10"
    ]
  },
  {
    "id": "F12",
    "dependencies": [
      "F11"
    ]
  },
  {
    "id": "F13",
    "dependencies": [
      "F11"
    ]
  },
  {
    "id": "F14",
    "dependencies": [
      "F00"
    ]
  },
  {
    "id": "F15",
    "dependencies": [
      "F14"
    ]
  },
  {
    "id": "F16",
    "dependencies": [
      "F10"
    ]
  },
  {
    "id": "F17",
    "dependencies": [
      "F10"
    ]
  },
  {
    "id": "F18",
    "dependencies": [
      "F00"
    ]
  },
  {
    "id": "F19",
    "dependencies": [
      "F00"
    ]
  },
  {
    "id": "F20",
    "dependencies": [
      "F19"
    ]
  },
  {
    "id": "F21",
    "dependencies": [
      "F18",
      "F19"
    ]
  },
  {
    "id": "F22",
    "dependencies": [
      "F19",
      "F20"
    ]
  },
  {
    "id": "F23",
    "dependencies": [
      "F18"
    ]
  },
  {
    "id": "F24",
    "dependencies": [
      "F18"
    ]
  },
  {
    "id": "F25",
    "dependencies": [
      "F19"
    ]
  },
  {
    "id": "F26",
    "dependencies": [
      "F00"
    ]
  },
  {
    "id": "F27",
    "dependencies": [
      "F00"
    ]
  },
  {
    "id": "F28",
    "dependencies": [
      "F18",
      "F19",
      "F25"
    ]
  },
  {
    "id": "F29",
    "dependencies": [
      "F00"
    ]
  },
  {
    "id": "F30",
    "dependencies": [
      "F29",
      "F06"
    ]
  },
  {
    "id": "F31",
    "dependencies": [
      "F00",
      "F14"
    ]
  },
  {
    "id": "F32",
    "dependencies": [
      "F20",
      "F22"
    ]
  },
  {
    "id": "F33",
    "dependencies": [
      "F02"
    ]
  },
  {
    "id": "F34",
    "dependencies": [
      "F33",
      "F14"
    ]
  },
  {
    "id": "F35",
    "dependencies": [
      "F28"
    ]
  },
  {
    "id": "F36",
    "dependencies": [
      "F10"
    ]
  },
  {
    "id": "F37",
    "dependencies": [
      "F28",
      "F26"
    ]
  },
  {
    "id": "F38",
    "dependencies": [
      "F00"
    ]
  },
  {
    "id": "F39",
    "dependencies": [
      "F28"
    ]
  },
  {
    "id": "F40",
    "dependencies": [
      "F28"
    ]
  },
  {
    "id": "F41",
    "dependencies": [
      "F01",
      "F15",
      "F17",
      "F26",
      "F31"
    ]
  },
  {
    "id": "F42",
    "dependencies": [
      "F01",
      "F05",
      "F07",
      "F27",
      "F29",
      "F34"
    ]
  },
  {
    "id": "F43",
    "dependencies": [
      "F01",
      "F22",
      "F24",
      "F25",
      "F28",
      "F35"
    ]
  },
  {
    "id": "F44",
    "dependencies": [
      "F01",
      "F06",
      "F15",
      "F30",
      "F38"
    ]
  },
  {
    "id": "F45",
    "dependencies": [
      "F00",
      "F01",
      "F02",
      "F03",
      "F04",
      "F05",
      "F06",
      "F07",
      "F08",
      "F09",
      "F10",
      "F11",
      "F12",
      "F13",
      "F14",
      "F15",
      "F16",
      "F17",
      "F18",
      "F19",
      "F20",
      "F21",
      "F22",
      "F23",
      "F24",
      "F25",
      "F26",
      "F27",
      "F28",
      "F29",
      "F30",
      "F31",
      "F32",
      "F33",
      "F34",
      "F35",
      "F36",
      "F37",
      "F38",
      "F39",
      "F40",
      "F41",
      "F42",
      "F43",
      "F44",
      "F46",
      "F47",
      "F48",
      "F49"
    ]
  },
  {
    "id": "F46",
    "dependencies": [
      "F29",
      "F09",
      "F14"
    ]
  },
  {
    "id": "F47",
    "dependencies": [
      "F28",
      "F35",
      "F37",
      "F41",
      "F42",
      "F43",
      "F44",
      "F46"
    ]
  },
  {
    "id": "F48",
    "dependencies": [
      "F00",
      "F01",
      "F02",
      "F03",
      "F04",
      "F05",
      "F06",
      "F07",
      "F08",
      "F09",
      "F10",
      "F11",
      "F12",
      "F13",
      "F14",
      "F15",
      "F16",
      "F17",
      "F18",
      "F19",
      "F20",
      "F21",
      "F22",
      "F23",
      "F24",
      "F25",
      "F26",
      "F27",
      "F28",
      "F29",
      "F30",
      "F31",
      "F32",
      "F33",
      "F34",
      "F35",
      "F36",
      "F37",
      "F38",
      "F39",
      "F40",
      "F41",
      "F42",
      "F43",
      "F44",
      "F46"
    ]
  },
  {
    "id": "F49",
    "dependencies": [
      "F05",
      "F06",
      "F08",
      "F14",
      "F15",
      "F21",
      "F29",
      "F30",
      "F33",
      "F34",
      "F36",
      "F37",
      "F38",
      "F46"
    ]
  }
] as const;
export type FeatureId = typeof FEATURES[number]["id"];
export const CASE_OWNERS: Readonly<Record<string, readonly FeatureId[]>> = {
  "R01": [
    "F00",
    "F45",
    "F47"
  ],
  "R02": [
    "F00",
    "F45",
    "F47"
  ],
  "R03": [
    "F00",
    "F45"
  ],
  "R04": [
    "F00",
    "F45",
    "F47"
  ],
  "R05": [
    "F00",
    "F45",
    "F47"
  ],
  "R06": [
    "F00",
    "F45",
    "F47"
  ],
  "R07": [
    "F00",
    "F45"
  ],
  "R08": [
    "F04",
    "F05",
    "F06",
    "F45",
    "F47",
    "F49"
  ],
  "R09": [
    "F03",
    "F04",
    "F05",
    "F06",
    "F45"
  ],
  "R10": [
    "F04",
    "F05",
    "F06",
    "F45",
    "F47"
  ],
  "R11": [
    "F03",
    "F04",
    "F05",
    "F06",
    "F45"
  ],
  "R12": [
    "F03",
    "F04",
    "F05",
    "F06",
    "F45"
  ],
  "R13": [
    "F04",
    "F05",
    "F06",
    "F45",
    "F47",
    "F49"
  ],
  "R14": [
    "F04",
    "F05",
    "F06",
    "F45",
    "F47",
    "F49"
  ],
  "R15": [
    "F07",
    "F04",
    "F05",
    "F06",
    "F45",
    "F47"
  ],
  "R16": [
    "F07",
    "F04",
    "F05",
    "F06",
    "F45",
    "F47"
  ],
  "R17": [
    "F07",
    "F04",
    "F05",
    "F06",
    "F45",
    "F47"
  ],
  "R18": [
    "F07",
    "F04",
    "F05",
    "F06",
    "F45",
    "F47"
  ],
  "R19": [
    "F07",
    "F04",
    "F05",
    "F06",
    "F45",
    "F47"
  ],
  "R20": [
    "F08",
    "F45",
    "F47"
  ],
  "R21": [
    "F08",
    "F45",
    "F47",
    "F49"
  ],
  "R22": [
    "F09",
    "F45"
  ],
  "R23": [
    "F09",
    "F45"
  ],
  "R24": [
    "F45"
  ],
  "R25": [
    "F03",
    "F04",
    "F05",
    "F06",
    "F45",
    "F48"
  ],
  "R26": [
    "F04",
    "F05",
    "F06",
    "F45",
    "F47",
    "F49"
  ],
  "R27": [
    "F04",
    "F05",
    "F06",
    "F45",
    "F47",
    "F49"
  ],
  "R28": [
    "F04",
    "F05",
    "F06",
    "F45",
    "F47",
    "F49"
  ],
  "R29": [
    "F02",
    "F45",
    "F48"
  ],
  "R30": [
    "F04",
    "F05",
    "F06",
    "F45",
    "F47",
    "F49"
  ],
  "R31": [
    "F04",
    "F05",
    "F06",
    "F45",
    "F47"
  ],
  "R32": [
    "F45",
    "F47",
    "F48"
  ],
  "RX01": [
    "F04",
    "F05",
    "F06",
    "F45",
    "F47"
  ],
  "RX02": [
    "F04",
    "F05",
    "F06",
    "F45",
    "F47",
    "F49"
  ],
  "RX03": [
    "F02",
    "F04",
    "F05",
    "F06",
    "F45",
    "F48"
  ],
  "RX04": [
    "F03",
    "F04",
    "F05",
    "F06",
    "F45",
    "F48"
  ],
  "RX05": [
    "F04",
    "F05",
    "F06",
    "F45",
    "F47"
  ],
  "RX06": [
    "F04",
    "F05",
    "F06",
    "F45",
    "F47",
    "F49"
  ],
  "RX07": [
    "F07",
    "F04",
    "F05",
    "F06",
    "F45",
    "F47"
  ],
  "RX08": [
    "F04",
    "F05",
    "F06",
    "F45",
    "F47",
    "F49"
  ],
  "RX09": [
    "F02",
    "F04",
    "F05",
    "F06",
    "F45",
    "F48"
  ],
  "RX10": [
    "F45",
    "F47",
    "F48",
    "F49"
  ],
  "RX11": [
    "F45"
  ],
  "RX12": [
    "F45",
    "F04",
    "F05",
    "F06",
    "F07",
    "F49"
  ],
  "AD-01": [
    "F11",
    "F12",
    "F13"
  ],
  "AD-02": [
    "F10",
    "F12",
    "F17"
  ],
  "AD-03": [
    "F19",
    "F22",
    "F25"
  ],
  "AD-04": [
    "F18",
    "F21",
    "F23"
  ],
  "AD-05": [
    "F20"
  ],
  "AD-06": [
    "F14",
    "F15",
    "F49"
  ],
  "AD-07": [
    "F24",
    "F25"
  ],
  "AD-08": [
    "F26",
    "F27"
  ],
  "AD-09": [
    "F28"
  ],
  "AD-10": [
    "F29",
    "F30"
  ],
  "AD-11": [
    "F31",
    "F32"
  ],
  "AD-12": [
    "F33",
    "F34",
    "F46",
    "F49"
  ],
  "AD-13": [
    "F35",
    "F36",
    "F21",
    "F49"
  ],
  "AD-14": [
    "F37",
    "F38",
    "F39",
    "F40",
    "F45",
    "F47",
    "F48"
  ],
  "AD-15": [
    "F00",
    "F01",
    "F02",
    "F03",
    "F04",
    "F05",
    "F06",
    "F07",
    "F08",
    "F09",
    "F10",
    "F11",
    "F12",
    "F13",
    "F14",
    "F15",
    "F16",
    "F17",
    "F18",
    "F19",
    "F20",
    "F21",
    "F22",
    "F23",
    "F24",
    "F25",
    "F26",
    "F27",
    "F28",
    "F29",
    "F30",
    "F31",
    "F32",
    "F33",
    "F34",
    "F35",
    "F36",
    "F37",
    "F38",
    "F39",
    "F40",
    "F41",
    "F42",
    "F43",
    "F44",
    "F45",
    "F46",
    "F47",
    "F48",
    "F49"
  ]
};
export type Cell = {
  id: string; stage: Stage; features: FeatureId[]; contracts: string[];
  host: Host | null; engine: typeof ENGINES[number] | null; profile: string; expectedTests: string[] | null; enginePin: { version: string; sha256: string } | null; expectedOutputs: { id: string; sha256: string }[] | null;
};
export type Manifest = {
  schema: "runphantom.assembly-manifest/v1"; source: SourcePin;
  features: { id: FeatureId; dependencies: FeatureId[]; head: string | null }[];
  cells: Cell[];
  profiles: { host: Host; mode: "source" | "installed"; artifactSha256: string | null; runtimeVersion: string | null;
    database: { engineVersion: string; engineSourceId: string; busyTimeout: number; journalMode: string; synchronous: number; foreignKeys: number } | null; resourceSha256: string[] }[];
};
export type Artifact = { path: string; sha256: string; bytes: number };
export type TestResult = { id: string; status: "passed" | "failed" | "skipped" | "uncollected"; attempt: number };
export type RuntimeEvidence = {
  mode: "source" | "installed"; runtimeVersion: string;
  artifact: Artifact | null; database: { engineVersion: string; engineSourceId: string; busyTimeout: number; journalMode: string; synchronous: number; foreignKeys: number; observedByApplication: boolean };
  restart: { firstPid: number; secondPid: number; firstClosed: boolean; sameDatabase: boolean; before: string; after: string };
  resources: Artifact[]; outsideCheckout: boolean; noSourceFallback: boolean;
  engine: { name: string; version: string; executable: Artifact } | null;
};
export type Receipt = {
  schema: "runphantom.assembly-receipt/v1"; cellId: string; stage: Stage;
  scope: "control" | "product"; source: SourcePin; host: Host; manifestSha256: string;
  execution: { command: string[]; exitCode: number | null; timedOut: boolean; signal: string | null; startedAt: string; finishedAt: string; log: Artifact };
  expectedTests: string[]; tests: TestResult[];
  invariants: { id: string; passed: boolean; artifact: Artifact }[];
  outputs: { id: string; actual: Artifact; expectedSha256: string }[];
  runtime: RuntimeEvidence | null;
  provider: { meteredLive: boolean; provider: string; operationId: string; usageKnown: boolean; usage: Artifact; budget: Artifact } | null;
  cleanup: { allOwnedClosed: boolean; profilesRemoved: boolean };
};
// Reviews are a separate trusted caller input, never taken from the evidence bundle itself.
export type IndependentReview = { cellId: string; receiptSha256: string; source: SourcePin; host: Host; stage: Stage; decision: "approved" };
export type SubmittedReceipt = { receipt: Receipt; artifact: Artifact };
export type Blocker = { cellId: string; code: string };
export type AssemblyResult = {
  schema: "runphantom.assembly-result/v1"; source: SourcePin;
  verdict: "BLOCKED" | "CHECKS_ONLY" | "QUALIFIED"; checksComplete: boolean; releaseQualified: boolean;
  stages: Record<Stage, { expected: number; valid: number; accepted: number }>;
  blockers: Blocker[];
};
export function hostId(host: Host): string { return `${host.platform}-${host.arch}`; }
export function fullCells(): Cell[] {
  const cells: Cell[] = [];
  const add = (id: string, stage: Stage, features: readonly FeatureId[], contracts: string[] = [], host: Host | null = null,
    engine: Cell["engine"] = null, profile = "enabled") => cells.push({ id, stage, features: [...features], contracts, host, engine, profile, expectedTests: null, enginePin: null, expectedOutputs: null });
  for (const feature of FEATURES) for (const stage of ["component", "source", "installed"] as const) add(`${feature.id}/${stage}`, stage, [feature.id]);
  for (const [id, owners] of Object.entries(CASE_OWNERS)) for (const stage of ["source", "installed"] as const) add(`${id}/${stage}`, stage, owners, [id]);
  for (const host of HOSTS) {
    for (const profile of ["source-backend", "installed-backend", "live-browser-ui", "optional-engines", "cooperating-electron", "cooperating-tauri"]) {
      add(`native/${hostId(host)}/${profile}`, "platform", ["F48"], ["R29", "R32", "RX09", "RX10", "AD-14"], host, null, profile);
    }
    for (const engine of ENGINES) add(`browser/${hostId(host)}/${engine}`, "platform", ["F47"], ["AD-09", "AD-14", "AD-15"], host, engine);
  }
  for (const feature of ["F11", "F12", "F13", "F34", "F38", "F46", "F49"] as const) add(`provider/${feature}`, "provider", [feature], ["AD-01", "AD-12", "AD-14"]);
  for (const profile of ["all-features-enabled", "optional-features-disabled", "restart-migration-rollback", "privacy-resources"]) {
    add(`assembled/${profile}`, "assembled", FEATURES.map(f => f.id), Object.keys(CASE_OWNERS), null, null, profile);
  }
  return cells;
}
export function createManifest(source: SourcePin, heads: Partial<Record<FeatureId, string>> = {}): Manifest {
  return { schema: "runphantom.assembly-manifest/v1", source,
    features: FEATURES.map(f => ({ id: f.id, dependencies: [...f.dependencies], head: heads[f.id] ?? null })), cells: fullCells(), profiles: HOSTS.flatMap(host => (["source", "installed"] as const).map(mode => ({ host, mode, artifactSha256: null, runtimeVersion: null, database: null, resourceSha256: [] }))) };
}
export function requiredInvariants(cell: Cell): string[] {
  const base = ["actual-output", "bounded-resources", "no-unexpected-errors", "owned-cleanup"];
  if (cell.stage !== "component") base.push("database-settings", "restart-persistence", "resources-available");
  if (["installed", "platform", "assembled"].includes(cell.stage)) base.push("outside-checkout", "no-source-fallback", "migration-rollback");
  if (cell.engine) base.push("trusted-input", "normal-ui-output", "sanitized-screenshot");
  if (cell.stage === "provider") base.push("metered-output", "spend-admission", "usage-reconciliation");
  if (cell.stage === "assembled") base.push("all-selected-features", "privacy-scope-retention", "frozen-evaluations", "replay-identity");
  return base;
}
