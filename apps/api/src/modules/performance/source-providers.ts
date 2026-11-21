/**
 * Report source providers (phase 4 row 4.3; SPEC 2.11 adapters).
 *
 * Purpose: a sync source says HOW its report is read (`sync_source.adapter_kind`: `sheet`,
 * `api`; `excel` is upload-only) and holds the reader's settings sealed in
 * `config_encrypted`. The sync engine never knows which reader is behind a kind: it asks this
 * registry to open a `ReportSource` for the source and reads the tab named by the column
 * mapping. Row 4.4 registers the read-only Google Sheets reader for `sheet`
 * (./google-connection.ts); tests register in-memory readers. A kind with no provider is a
 * configuration problem the run reports (and alerts admins about), never a crash.
 *
 * Depends on: ./report-adapter.ts, kernel/db (context type). Used by: ./sync-service.ts, src/main.ts, the sync tests.
 */
import type { DbContext } from '../../kernel/db/unit-of-work.js';
import type { ReportSource } from './report-adapter.js';

/** What a provider is given to open a source. */
export interface SourceOpenRequest {
  syncSourceId: string;
  adapterKind: string;
  /** The opened `config_encrypted` as JSON, or null when nothing is configured yet. */
  config: Record<string, unknown> | null;
  /**
   * Who the run acts for (tenant, companies, user). A reader that keeps tenant settings of
   * its own (the Google connection) reads them in this context, under row-level security.
   */
  context: DbContext;
}

export interface ReportSourceProvider {
  /** `sync_source.adapter_kind` this provider reads. */
  readonly adapterKind: string;
  open(request: SourceOpenRequest): ReportSource;
}

export class ReportSourceProviders {
  readonly #providers = new Map<string, ReportSourceProvider>();

  register(provider: ReportSourceProvider): void {
    if (this.#providers.has(provider.adapterKind)) {
      throw new Error(`Report source provider registered twice: ${provider.adapterKind}`);
    }
    this.#providers.set(provider.adapterKind, provider);
  }

  /** The provider for a kind, or undefined when none is installed. */
  get(adapterKind: string): ReportSourceProvider | undefined {
    return this.#providers.get(adapterKind);
  }
}
