use super::traits::{Tool, ToolResult};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;
use tracing::{info, warn, error};

/// Finance tool for fetching stock prices and market data.
/// Currently uses the public Yahoo Finance API.
pub struct FinanceTool;

#[derive(Debug, Deserialize)]
struct YahooResponse {
    chart: Chart,
}

#[derive(Debug, Deserialize)]
struct Chart {
    result: Option<Vec<ChartResult>>,
    error: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct ChartResult {
    meta: Meta,
}

#[derive(Debug, Deserialize)]
struct Meta {
    currency: Option<String>,
    symbol: String,
    #[serde(rename = "regularMarketPrice")]
    regular_market_price: Option<f64>,
    #[serde(rename = "chartPreviousClose")]
    previous_close: Option<f64>,
}

impl FinanceTool {
    pub fn new() -> Self {
        Self
    }

    async fn fetch_quote(symbol: &str) -> anyhow::Result<Meta> {
        let url = format!(
            "https://query1.finance.yahoo.com/v8/finance/chart/{}?interval=1d&range=1d",
            symbol.to_uppercase()
        );

        info!("FinanceTool: fetching quote for symbol '{}'", symbol);
        let builder = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

        let builder = crate::config::apply_runtime_proxy_to_builder(builder, "tool.finance");
        let client = builder.build()?;

        let response = client.get(&url).send().await?;
        if !response.status().is_success() {
            let status = response.status();
            error!("FinanceTool: API returned error status {} for {}", status, symbol);
            anyhow::bail!("Finance API returned status: {}", status);
        }

        let json: YahooResponse = response.json().await?;
        if let Some(err) = json.chart.error {
            error!("FinanceTool: API error details for {}: {:?}", symbol, err);
            anyhow::bail!("Finance API error: {:?}", err);
        }

        let result = json.chart.result
            .and_then(|r| r.into_iter().next())
            .ok_or_else(|| {
                warn!("FinanceTool: No results found for symbol {}", symbol);
                anyhow::anyhow!("No results found for symbol: {}", symbol)
            })?;

        info!("FinanceTool: Successfully fetched metadata for {}", symbol);
        Ok(result.meta)
    }

    fn format_quote(meta: &Meta) -> String {
        let price = meta.regular_market_price.unwrap_or(0.0);
        let prev = meta.previous_close.unwrap_or(price);
        let currency = meta.currency.as_deref().unwrap_or("USD");
        
        let change = price - prev;
        let change_percent = if prev != 0.0 { (change / prev) * 100.0 } else { 0.0 };
        let sign = if change >= 0.0 { "+" } else { "" };

        format!(
            "{}: {:.2} {} ({}{:.2} / {}{:.2}%)",
            meta.symbol, price, currency, sign, change, sign, change_percent
        )
    }
}

#[async_trait]
impl Tool for FinanceTool {
    fn name(&self) -> &str {
        "finance"
    }

    fn description(&self) -> &str {
        "Fetch current stock prices and market data for specified symbols (e.g., AAPL, GOOGL, MSFT, BTC-USD). Returns price, currency, and daily change."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "symbols": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "List of stock or crypto symbols to fetch (e.g. ['AAPL', 'BTC-USD'])."
                }
            },
            "required": ["symbols"]
        })
    }

    async fn execute(&self, args: Value) -> anyhow::Result<ToolResult> {
        info!("FinanceTool: execution started with args: {:?}", args);
        let symbols = args.get("symbols")
            .and_then(|v| v.as_array())
            .ok_or_else(|| {
                error!("FinanceTool: Missing required parameter 'symbols'");
                anyhow::anyhow!("Missing required parameter: symbols (must be an array)")
            })?;

        if symbols.is_empty() {
            anyhow::bail!("Symbols list cannot be empty");
        }

        let mut outputs = Vec::new();
        let mut errors = Vec::new();

        for sym_val in symbols {
            let sym = sym_val.as_str().unwrap_or("");
            if sym.is_empty() { continue; }

            match Self::fetch_quote(sym).await {
                Ok(meta) => {
                    info!("FinanceTool: Successfully fetched meta for {}", sym);
                    outputs.push(Self::format_quote(&meta));
                },
                Err(e) => {
                    error!("FinanceTool: Error for {}: {:?}", sym, e);
                    errors.push(format!("{}: {}", sym, e));
                },
            }
        }

        info!("FinanceTool: execution finished. success_count={}, error_count={}", outputs.len(), errors.len());

        let output = if !outputs.is_empty() {
            outputs.join("\n")
        } else {
            "No data found for any of the symbols.".to_string()
        };

        let final_error = if !errors.is_empty() {
            Some(errors.join("; "))
        } else {
            None
        };

        Ok(ToolResult {
            success: !outputs.is_empty(),
            output,
            error: final_error,
        })
    }
}
