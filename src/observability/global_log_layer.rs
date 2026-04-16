use tracing_subscriber::Layer;
use tracing::{Subscriber, Event};
use tracing_subscriber::layer::Context;
use chrono::Utc;
use crate::observability::AgentLogEntry;

pub struct GlobalLogLayer;

impl<S> Layer<S> for GlobalLogLayer
where
    S: Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a>,
{
    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        // 1. Extract message
        let mut visitor = LogVisitor::default();
        event.record(&mut visitor);

        if visitor.message.is_empty() {
             return;
        }

        // 2. Find agent name if present in scope (from AgentLogLayer's extension)
        let agent_name = ctx
            .lookup_current()
            .and_then(|span| {
                span.scope().find_map(|s| {
                    s.extensions().get::<crate::observability::agent_log_layer::AgentNameExtension>().map(|ext| ext.0.clone())
                })
            })
            .unwrap_or_else(|| "System".to_string());

        let entry = AgentLogEntry {
            timestamp: Utc::now().to_rfc3339(),
            level: event.metadata().level().to_string(),
            agent: agent_name.clone(),
            message: visitor.message,
            target: event.metadata().target().to_string(),
        };

        // 3. Broadcast to the system log channel
        let _ = crate::observability::get_system_log_tx().send(entry.clone());

        // 4. Also broadcast to the agent log channel if it's an agent log
        if agent_name != "System" {
            let _ = crate::observability::get_agent_log_tx().send(entry);
        }
    }
}

#[derive(Default)]
struct LogVisitor {
    message: String,
}

impl tracing::field::Visit for LogVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.message = format!("{:?}", value);
        }
    }

    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_string();
        }
    }
}
