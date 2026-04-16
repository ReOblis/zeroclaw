use tracing_subscriber::Layer;
use tracing::{Subscriber, Event};
use tracing_subscriber::layer::Context;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use chrono::Utc;
use crate::observability::AgentLogEntry;

pub struct AgentLogLayer {
    workspace_dir: PathBuf,
}

impl AgentLogLayer {
    pub fn new(workspace_dir: PathBuf) -> Self {
        Self { workspace_dir }
    }

    fn get_log_file(&self, agent_name: &str) -> PathBuf {
        let mut path = self.workspace_dir.clone();
        path.push("agents");
        path.push(agent_name);
        path.push("logs");
        // Ensure directory exists
        std::fs::create_dir_all(&path).ok();
        path.push("activity.log");
        path
    }
}

impl<S> Layer<S> for AgentLogLayer
where
    S: Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a>,
{
    fn on_new_span(&self, attrs: &tracing::span::Attributes<'_>, id: &tracing::Id, ctx: Context<'_, S>) {
        let span = ctx.span(id).expect("Span not found");
        let mut visitor = AgentFieldVisitor::default();
        attrs.record(&mut visitor);
        if let Some(agent_name) = visitor.agent {
            span.extensions_mut().insert(AgentNameExtension(agent_name));
        }
    }

    fn on_record(&self, id: &tracing::Id, values: &tracing::span::Record<'_>, ctx: Context<'_, S>) {
        let span = ctx.span(id).expect("Span not found");
        let mut visitor = AgentFieldVisitor::default();
        values.record(&mut visitor);
        if let Some(agent_name) = visitor.agent {
            span.extensions_mut().insert(AgentNameExtension(agent_name));
        }
    }

    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        // Look for the AgentNameExtension in the current span or its parents
        let agent_name = ctx
            .lookup_current()
            .and_then(|span| {
                // Search up the span hierarchy for the AgentNameExtension
                span.scope().find_map(|s| {
                    s.extensions().get::<AgentNameExtension>().map(|ext| ext.0.clone())
                })
            });

        let agent_name = match agent_name {
            Some(name) => name,
            None => return, // Not an agent-scoped event
        };

        // Extract message and other fields
        let mut visitor = LogVisitor::default();
        event.record(&mut visitor);

        let entry = AgentLogEntry {
            timestamp: Utc::now().to_rfc3339(),
            level: event.metadata().level().to_string(),
            agent: agent_name.clone(),
            message: visitor.message,
            target: event.metadata().target().to_string(),
        };

        // 1. Write to file (JSON Lines)
        if let Ok(json) = serde_json::to_string(&entry) {
            let log_file = self.get_log_file(&agent_name);
            if let Ok(mut file) = OpenOptions::new()
                .create(true)
                .append(true)
                .open(log_file)
            {
                let _ = writeln!(file, "{}", json);
            }

            // 2. Broadcast to SSE
            let _ = crate::observability::get_agent_log_tx().send(entry);
        }
    }
}

/// Extension type to store agent name in span extensions
pub struct AgentNameExtension(pub String);

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

#[derive(Default)]
struct AgentFieldVisitor {
    agent: Option<String>,
}

impl tracing::field::Visit for AgentFieldVisitor {
    fn record_debug(&mut self, _field: &tracing::field::Field, _value: &dyn std::fmt::Debug) {}

    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "agent" {
            self.agent = Some(value.to_string());
        }
    }
}
