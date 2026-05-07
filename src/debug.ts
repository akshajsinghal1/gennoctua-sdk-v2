import type { ProductContext, SelectionSummary, EligibilityResult, PersonalizationState, ViewMode } from "./types.js";

export type DebugState = {
  product: {
    context: ProductContext | null;
    imageSource: string | null;
    typeSource: string | null;
  };
  selection: {
    summary: SelectionSummary | null;
    availableCategories: string[];
    missingRequiredCategory: string | null;
  };
  eligibility: EligibilityResult | null;
  personalization: {
    state: PersonalizationState;
    activeJobId: string | null;
    cacheKey: string | null;
    lastError: string | null;
  };
  view: {
    mode: ViewMode;
  };
  rateLimit: {
    personalizationSessionCount: number;
    lastPersonalizationAt: number | null;
  };
};

export class DebugService {
  private enabled: boolean;
  private state: DebugState = {
    product: { context: null, imageSource: null, typeSource: null },
    selection: { summary: null, availableCategories: [], missingRequiredCategory: null },
    eligibility: null,
    personalization: { state: "idle", activeJobId: null, cacheKey: null, lastError: null },
    view: { mode: "original" },
    rateLimit: { personalizationSessionCount: 0, lastPersonalizationAt: null },
  };

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  getState(): DebugState {
    return structuredClone(this.state);
  }

  setProductContext(ctx: ProductContext | null): void {
    this.state.product.context = ctx;
    this.state.product.imageSource = ctx?.image.source ?? null;
    this.state.product.typeSource = ctx?.productTypeSource ?? null;
    if (this.enabled) {
      console.info("[personalize-sdk:debug] product_context", ctx);
    }
  }

  setSelectionSummary(summary: SelectionSummary | null, missingRequired: string | null): void {
    this.state.selection.summary = summary;
    this.state.selection.availableCategories = summary?.availableCategories ?? [];
    this.state.selection.missingRequiredCategory = missingRequired;
    if (this.enabled) {
      console.info("[personalize-sdk:debug] selection_summary", summary);
    }
  }

  setEligibility(result: EligibilityResult | null): void {
    this.state.eligibility = result;
    if (this.enabled) {
      console.info("[personalize-sdk:debug] eligibility", result);
    }
  }

  setPersonalizationState(state: PersonalizationState, jobId?: string | null, error?: string | null): void {
    this.state.personalization.state = state;
    if (jobId !== undefined) this.state.personalization.activeJobId = jobId;
    if (error !== undefined) this.state.personalization.lastError = error;
    if (this.enabled) {
      console.info(`[personalize-sdk:debug] personalization_state=${state}`, { jobId, error });
    }
  }

  setViewMode(mode: ViewMode): void {
    this.state.view.mode = mode;
    if (this.enabled) {
      console.info(`[personalize-sdk:debug] view_mode=${mode}`);
    }
  }

  log(label: string, data?: unknown): void {
    if (!this.enabled) return;
    console.info(`[personalize-sdk:debug] ${label}`, data ?? "");
  }
}
