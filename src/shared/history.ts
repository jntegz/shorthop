// Link change history: the snapshot stored per version, and the field-level
// differences between two snapshots. Shared by the Worker and the admin.

/** The fields a version records and a restore puts back. */
export const HISTORY_FIELDS = [
  "target",
  "routing",
  "preview",
  "qr",
  "title",
  "active",
  "expires_at",
  "broken",
  "replacement",
  "utm",
  "utm_template",
  "pass_query",
  "monitor",
  "tags",
  "notes",
] as const;
export type HistoryField = (typeof HISTORY_FIELDS)[number];

export interface Snapshot {
  target: string;
  active: number;
  expires_at: number | null;
  utm: number;
  utm_template: string | null;
  pass_query: number;
  title: string | null;
  /** Comma-separated, as stored. */
  tags: string;
  notes: string;
  broken: number;
  /** "domain/slug" or null. */
  replacement: string | null;
  monitor: number;
  /** Smart routing JSON, or null. Versions saved before routing existed lack it. */
  routing?: string | null;
  /** Social preview JSON, or null. Versions saved before previews existed lack it. */
  preview?: string | null;
  /** QR design JSON, or null. Versions saved before designs existed lack it. */
  qr?: string | null;
}

/** What's stored: the restorable fields plus what re-creating a deleted link needs. */
export interface StoredSnapshot extends Snapshot {
  source: "native" | "import";
  imported_clicks: number | null;
  created_at: number;
}

export const HISTORY_ACTIONS = ["baseline", "create", "update", "import", "restore", "delete"] as const;
export type HistoryAction = (typeof HISTORY_ACTIONS)[number];

/** Deleted links can be brought back for this long. */
export const DELETED_RETENTION_DAYS = 90;
/** Older versions are dropped after this long (a link's latest one is always kept). */
export const HISTORY_RETENTION_DAYS = 365;

export interface FieldChange {
  field: HistoryField;
  before: Snapshot[HistoryField] | null;
  after: Snapshot[HistoryField];
}

/** Normalizes values so "" and null, or a missing monitor flag, don't count as changes. */
function norm(field: HistoryField, v: unknown): unknown {
  if (v === undefined || v === "") return field === "monitor" ? 1 : null;
  // Only the rules matter, not when the split last changed.
  if (field === "routing" && typeof v === "string") {
    try {
      return JSON.stringify((JSON.parse(v) as { rules?: unknown }).rules ?? null);
    } catch {
      return v;
    }
  }
  return v;
}

/** The fields that differ, in HISTORY_FIELDS order. `before` null means "nothing before". */
export function diffSnapshots(before: Snapshot | null, after: Snapshot): FieldChange[] {
  if (!before) return [];
  const out: FieldChange[] = [];
  for (const field of HISTORY_FIELDS) {
    if (norm(field, before[field]) !== norm(field, after[field])) out.push({ field, before: before[field], after: after[field] });
  }
  return out;
}

export function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return diffSnapshots(a, b).length === 0;
}

/** Picks the history fields out of a link row (or anything shaped like one). */
export function snapshotOf<T extends StoredSnapshot>(row: T): StoredSnapshot {
  return {
    target: row.target,
    active: row.active,
    expires_at: row.expires_at,
    utm: row.utm,
    utm_template: row.utm_template,
    pass_query: row.pass_query,
    title: row.title,
    tags: row.tags,
    notes: row.notes,
    broken: row.broken,
    replacement: row.replacement,
    monitor: row.monitor ?? 1,
    routing: row.routing ?? null,
    preview: row.preview ?? null,
    qr: row.qr ?? null,
    source: row.source,
    imported_clicks: row.imported_clicks,
    created_at: row.created_at,
  };
}

export const FIELD_LABEL: Record<HistoryField, string> = {
  target: "Destination",
  routing: "Smart routing",
  preview: "Social preview",
  qr: "QR code design",
  title: "Title",
  active: "Active",
  expires_at: "Expires",
  broken: "No longer working",
  replacement: "Replacement link",
  utm: "UTM parameters",
  utm_template: "UTM template",
  pass_query: "Pass query parameters",
  monitor: "Destination checks",
  tags: "Tags",
  notes: "Notes",
};

export const BOOLEAN_FIELDS: ReadonlySet<HistoryField> = new Set(["active", "broken", "utm", "pass_query", "monitor"]);
