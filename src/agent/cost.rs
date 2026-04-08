use crate::config::schema::ModelPricing;
use crate::cost::CostTracker;
use crate::cost::types::{BudgetCheck, TokenUsage as CostTokenUsage};
use std::sync::Arc;

// ── Cost tracking via task-local ──

/// Context for cost tracking within the tool call loop.
/// Scoped via `tokio::task_local!` at call sites (channels, gateway).
#[derive(Clone)]
pub(crate) struct ToolLoopCostTrackingContext {
    pub tracker: Arc<CostTracker>,
    pub prices: Arc<std::collections::HashMap<String, ModelPricing>>,
    pub turn_tokens: Arc<std::sync::atomic::AtomicU64>,
    pub turn_cost_nanos: Arc<std::sync::atomic::AtomicU64>,
}

impl ToolLoopCostTrackingContext {
    pub(crate) fn new(
        tracker: Arc<CostTracker>,
        prices: Arc<std::collections::HashMap<String, ModelPricing>>,
    ) -> Self {
        Self {
            tracker,
            prices,
            turn_tokens: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            turn_cost_nanos: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }
    }
}

tokio::task_local! {
    pub(crate) static TOOL_LOOP_COST_TRACKING_CONTEXT: Option<ToolLoopCostTrackingContext>;
}

/// Record token usage from an LLM response via the task-local cost tracker.
/// Returns `(total_tokens, cost_usd)` on success, `None` when not scoped or no usage.
pub(crate) fn record_tool_loop_cost_usage(
    provider_name: &str,
    model: &str,
    usage: &crate::providers::traits::TokenUsage,
) -> Option<(u64, f64)> {
    let input_tokens = usage.input_tokens.unwrap_or(0);
    let output_tokens = usage.output_tokens.unwrap_or(0);
    let total_tokens = input_tokens.saturating_add(output_tokens);
    if total_tokens == 0 {
        return None;
    }

    let ctx = TOOL_LOOP_COST_TRACKING_CONTEXT
        .try_with(Clone::clone)
        .ok()
        .flatten()?;
    // 3-tier model pricing lookup: direct name → provider/model → suffix after last `/`
    let pricing = ctx
        .prices
        .get(model)
        .or_else(|| ctx.prices.get(&format!("{provider_name}/{model}")))
        .or_else(|| {
            model
                .rsplit_once('/')
                .and_then(|(_, suffix)| ctx.prices.get(suffix))
        });
    let cost_usage = CostTokenUsage::new(
        model,
        input_tokens,
        output_tokens,
        pricing.map_or(0.0, |entry| entry.input),
        pricing.map_or(0.0, |entry| entry.output),
    );

    if pricing.is_none() {
        tracing::debug!(
            provider = provider_name,
            model,
            "Cost tracking recorded token usage with zero pricing (no pricing entry found)"
        );
    }

    if let Err(error) = ctx.tracker.record_usage(cost_usage.clone()) {
        tracing::warn!(
            provider = provider_name,
            model,
            "Failed to record cost tracking usage: {error}"
        );
    }

    // Accumulate for real-time AgentEnd reporting
    ctx.turn_tokens.fetch_add(cost_usage.total_tokens, std::sync::atomic::Ordering::Relaxed);
    #[allow(clippy::cast_possible_truncation)]
    #[allow(clippy::cast_sign_loss)]
    let cost_nanos = (cost_usage.cost_usd * 1_000_000_000.0) as u64;
    ctx.turn_cost_nanos.fetch_add(cost_nanos, std::sync::atomic::Ordering::Relaxed);

    Some((cost_usage.total_tokens, cost_usage.cost_usd))
}

/// Check budget before an LLM call. Returns `None` when no cost tracking
/// context is scoped (tests, delegate, CLI without cost config).
pub(crate) fn check_tool_loop_budget() -> Option<BudgetCheck> {
    TOOL_LOOP_COST_TRACKING_CONTEXT
        .try_with(Clone::clone)
        .ok()
        .flatten()
        .map(|ctx| {
            ctx.tracker
                .check_budget(0.0)
                .unwrap_or(BudgetCheck::Allowed)
        })
}
