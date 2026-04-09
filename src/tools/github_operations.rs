use super::traits::{Tool, ToolResult};
use crate::config::GitHubConfig;
use crate::security::SecurityPolicy;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;

/// GitHub operations tool for repository and commit management via API.
pub struct GitHubOperationsTool {
    config: GitHubConfig,
    security: Arc<SecurityPolicy>,
}

impl GitHubOperationsTool {
    pub fn new(config: GitHubConfig, security: Arc<SecurityPolicy>) -> Self {
        Self { config, security }
    }

    fn client(&self) -> reqwest::Client {
        crate::config::build_runtime_proxy_client_with_timeouts("tool.github", 30, 5)
    }

    async fn list_repos(&self) -> anyhow::Result<ToolResult> {
        let Some(ref token) = self.config.token else {
            anyhow::bail!("GitHub PAT is not configured. Please add [integrations.github] token = \"ghp_...\" to your config.toml");
        };

        let response = self
            .client()
            .get("https://api.github.com/user/repos")
            .header("Authorization", format!("token {token}"))
            .header("User-Agent", "ZeroClaw-Bot")
            .header("Accept", "application/vnd.github.v3+json")
            .query(&[("sort", "created"), ("direction", "desc")])
            .send()
            .await?;

        if !response.status().is_success() {
            anyhow::bail!("GitHub API request failed: {}", response.status());
        }

        let repos: Vec<GitHubRepo> = response.json().await?;
        
        let output = repos.iter().map(|r| {
            json!({
                "name": r.full_name,
                "description": r.description,
                "url": r.html_url,
                "created_at": r.created_at,
                "pushed_at": r.pushed_at,
            })
        }).collect::<Vec<_>>();

        Ok(ToolResult {
            success: true,
            output: json!({ "repositories": output }).to_string(),
            error: None,
        })
    }

    async fn read_latest_commit(&self, repo: &str) -> anyhow::Result<ToolResult> {
        let Some(ref token) = self.config.token else {
            anyhow::bail!("GitHub PAT is not configured.");
        };

        let url = format!("https://api.github.com/repos/{}/commits", repo);
        let response = self
            .client()
            .get(&url)
            .header("Authorization", format!("token {token}"))
            .header("User-Agent", "ZeroClaw-Bot")
            .header("Accept", "application/vnd.github.v3+json")
            .query(&[("per_page", "1")])
            .send()
            .await?;

        if !response.status().is_success() {
            anyhow::bail!("GitHub API request failed: {}", response.status());
        }

        let commits: Vec<GitHubCommit> = response.json().await?;
        let Some(commit) = commits.into_iter().next() else {
            anyhow::bail!("No commits found for repository {}", repo);
        };

        Ok(ToolResult {
            success: true,
            output: json!({
                "sha": commit.sha,
                "message": commit.commit.message,
                "author": commit.commit.author.name,
                "date": commit.commit.author.date,
                "url": commit.html_url,
            }).to_string(),
            error: None,
        })
    }
}

#[derive(Debug, Deserialize)]
struct GitHubRepo {
    full_name: String,
    description: Option<String>,
    html_url: String,
    created_at: String,
    pushed_at: String,
}

#[derive(Debug, Deserialize)]
struct GitHubCommit {
    sha: String,
    html_url: String,
    commit: CommitDetail,
}

#[derive(Debug, Deserialize)]
struct CommitDetail {
    message: String,
    author: AuthorDetail,
}

#[derive(Debug, Deserialize)]
struct AuthorDetail {
    name: String,
    date: String,
}

#[async_trait]
impl Tool for GitHubOperationsTool {
    fn name(&self) -> &str {
        "github_operations"
    }

    fn description(&self) -> &str {
        "Interact with GitHub repositories via API. Supports listing repositories (sorted by creation date) and reading the latest commit. Requires GitHub PAT."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "operation": {
                    "type": "string",
                    "description": "The operation to perform: 'list_repos' or 'read_latest_commit'",
                    "enum": ["list_repos", "read_latest_commit"]
                },
                "repository": {
                    "type": "string",
                    "description": "The full name of the repository (e.g. 'username/repo-name'). Required for 'read_latest_commit'."
                }
            },
            "required": ["operation"]
        })
    }

    async fn execute(&self, args: serde_json::Value) -> anyhow::Result<ToolResult> {
        let operation = args.get("operation").and_then(|v| v.as_str()).unwrap_or("");
        
        match operation {
            "list_repos" => self.list_repos().await,
            "read_latest_commit" => {
                let repo = args.get("repository").and_then(|v| v.as_str()).ok_or_else(|| {
                    anyhow::anyhow!("'repository' parameter is required for 'read_latest_commit' operation")
                })?;
                self.read_latest_commit(repo).await
            }
            _ => anyhow::bail!("Unsupported operation: {}", operation),
        }
    }
}
