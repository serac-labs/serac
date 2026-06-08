# Serac Enterprise MCP Proxy

## Overview

The Enterprise MCP Proxy bridges **SnowCode CLI** (stdio MCP protocol) with the **Serac Enterprise License Server** (HTTPS REST API), enabling enterprise features like Jira, Azure DevOps, and Confluence integrations.

### 🚀 Enterprise Tool Ecosystem

**Total: 76+ Enterprise Tools**

- 🎯 **Jira**: 22 tools (AI-powered workflow intelligence)
- ⚡ **Azure DevOps**: 26 tools (CI/CD + work item intelligence)
- 📚 **Confluence**: 24 tools (AI-powered documentation intelligence)
- 🔄 **Process Mining**: 4 tools (Process optimization)

**Key Capabilities:**

- ✅ AI-powered story generation and estimation
- ✅ Automated epic/feature decomposition
- ✅ Smart task suggestions based on context
- ✅ Dependency and blocker detection
- ✅ CI/CD pipeline failure analysis
- ✅ Team velocity tracking and forecasting
- ✅ Duplicate detection and similar issue search
- ✅ Bulk operations and automation
- ✅ AI-powered documentation generation and improvement
- ✅ Documentation gap analysis and suggestions
- ✅ Automated content summarization and formatting
- ✅ Space health reports and analytics

## Architecture

```
┌─────────────┐  stdio MCP   ┌──────────────┐  HTTPS REST   ┌─────────────────┐
│  SnowCode   │─────────────▶│  MCP Proxy   │──────────────▶│ License Server  │
│  CLI        │◀─────────────│  (LOKAAL)    │◀──────────────│  (CLOUD - GCP)  │
└─────────────┘              └──────────────┘               └─────────────────┘
```

## Configuration

The proxy is automatically configured when running `snow-flow auth login` with an enterprise license key.

### Environment Variables

```bash
# ============================================
# Required - Enterprise License
# ============================================
SNOW_LICENSE_KEY=SNOW-ENT-CUST-ABC123
SNOW_ENTERPRISE_URL=https://license-server.run.app

# ============================================
# Optional: Local Credentials
# (Otherwise uses server-side encrypted credentials)
# ============================================

# Jira Integration (22 tools)
JIRA_HOST=https://company.atlassian.net
JIRA_EMAIL=user@company.com
JIRA_API_TOKEN=ATATT3xFfGF0...
# Get token: https://id.atlassian.com/manage-profile/security/api-tokens

# Azure DevOps Integration (26 tools)
AZURE_DEVOPS_ORG=mycompany
AZURE_DEVOPS_PAT=xxxxxxxxxxxxxxxxxxxxx
# Get PAT: https://dev.azure.com/{org}/_usersSettings/tokens
# Required scopes: Work Items (Read, Write), Build (Read, Execute), Code (Read, Write)

# Confluence Integration (24 tools)
CONFLUENCE_HOST=https://company.atlassian.net
CONFLUENCE_EMAIL=user@company.com
CONFLUENCE_API_TOKEN=ATATT3xFfGF0...
# Same token as Jira (Atlassian Cloud uses same API tokens)
```

**Credential Priority:**

1. **Local environment variables** (shown above) - Sent encrypted to server
2. **Server-side encrypted storage** - Managed by enterprise admin
3. **Error** - If neither available, tool will fail with clear message

### SnowCode Configuration

Automatically added to `~/.config/snow-code/snow-code.json`:

```json
{
  "mcpServers": {
    "serac-enterprise": {
      "command": "node",
      "args": ["node_modules/snow-flow/dist/mcp/enterprise-proxy/index.js"],
      "env": {
        "SNOW_LICENSE_KEY": "SNOW-ENT-CUST-ABC123",
        "SNOW_ENTERPRISE_URL": "https://license-server.run.app",
        "JIRA_HOST": "...",
        "JIRA_EMAIL": "...",
        "JIRA_API_TOKEN": "..."
      }
    }
  }
}
```

## Files

- **index.ts** - MCP Server entry point (stdio transport)
- **server.ts** - Server setup and configuration
- **proxy.ts** - HTTPS client for enterprise server communication
- **credentials.ts** - Environment variable credential gathering
- **types.ts** - TypeScript type definitions

## Available Enterprise Tools

### 🎯 Jira Agent Intelligence (22 Tools)

The enterprise proxy includes comprehensive Jira integration with AI-powered workflow intelligence.

#### Phase 1: Foundation Tools (4)

1. **jira_get_active_sprint** - Get current sprint context and progress
2. **jira_get_epic_hierarchy** - View complete epic breakdown and story structure
3. **jira_get_board** - Board workflow, columns, and WIP limits
4. **jira_get_issue_comments** - Team discussions and collaboration context

#### Phase 2: Intelligence Tools (4)

5. **jira_create_user_story** - AI-generated user stories with acceptance criteria
6. **jira_analyze_issue_dependencies** - Automatic blocker and dependency detection
7. **jira_estimate_story_points** - AI-powered story point estimation
8. **jira_decompose_epic** - Automated epic breakdown into user stories

#### Phase 3: Optimization Tools (6)

9. **jira_suggest_next_task** - Smart task suggestions based on context
10. **jira_get_sprint_velocity** - Team velocity tracking and forecasting
11. **jira_find_similar_issues** - Duplicate detection and historical insights
12. **jira_bulk_update_issues** - Efficient bulk operations
13. **jira_get_team_capacity** - Team capacity analysis and planning
14. **jira_create_sprint_report** - Comprehensive sprint reporting

#### Original Jira Tools (8)

15. **jira_create_issue** - Create Jira issues
16. **jira_update_issue** - Update existing issues
17. **jira_get_issue** - Get issue details
18. **jira_search_issues** - JQL search
19. **jira_add_comment** - Add comments to issues
20. **jira_assign_issue** - Assign issues to users
21. **jira_transition_issue** - Workflow transitions
22. **jira_get_transitions** - Get available transitions

**Example Usage:**

```javascript
// AI suggests next task based on sprint, dependencies, and your skills
await jira_suggest_next_task({
  board_id: 123,
  user_id: "john.doe",
})
// Returns: "PROJ-102 (OAuth integration) - Blocks 3 stories, matches your skills"

// AI decomposes epic into stories
await jira_decompose_epic({
  epic_key: "PROJ-50",
})
// Creates 4 user stories with acceptance criteria and estimates
```

### ⚡ Azure DevOps Agent Intelligence (26 Tools)

Comprehensive Azure DevOps integration with AI-powered workflow intelligence and CI/CD analysis.

#### Phase 1: Foundation Tools (6)

1. **azure_get_active_iteration** - Get current iteration context and progress
2. **azure_get_work_item_hierarchy** - Epic → Feature → Story → Task breakdown
3. **azure_get_board** - Board workflow, columns, and WIP limits
4. **azure_get_work_item_comments** - Team discussions and collaboration context
5. **azure_analyze_work_item_dependencies** - Dependency and blocker detection
6. **azure_analyze_pipeline_failures** - CI/CD failure analysis with recommendations

#### Phase 2: Intelligence Tools (6)

7. **azure_create_user_story** - AI-generated user stories with acceptance criteria
8. **azure_estimate_work_item** - AI-powered story points/hours estimation
9. **azure_decompose_feature** - Automated feature breakdown into stories
10. **azure_suggest_next_work_item** - Smart work item suggestions
11. **azure_get_iteration_velocity** - Team velocity tracking and forecasting
12. **azure_find_similar_work_items** - Duplicate detection and historical insights

#### Phase 3: Optimization Tools (4)

13. **azure_bulk_update_work_items** - Efficient bulk operations
14. **azure_get_team_capacity** - Team capacity analysis and planning
15. **azure_create_iteration_report** - Comprehensive iteration reporting
16. **azure_pr_readiness_check** - PR quality gates and recommendations

#### Original Azure DevOps Tools (10)

17. **azure_create_work_item** - Create work items
18. **azure_update_work_item** - Update existing work items
19. **azure_get_work_item** - Get work item details
20. **azure_query_work_items** - WIQL queries
21. **azure_add_work_item_comment** - Add comments
22. **azure_link_work_items** - Link work items (parent/child, related, etc.)
23. **azure_get_pipeline_runs** - Get pipeline execution history
24. **azure_trigger_pipeline** - Trigger pipeline runs
25. **azure_get_pull_requests** - Get PR list and status
26. **azure_create_pull_request** - Create PRs

**Example Usage:**

```javascript
// AI suggests next work item based on iteration, dependencies, and capacity
await azure_suggest_next_work_item({
  team: "Platform Team",
  project: "MyProject",
})
// Returns: "Work Item 102 (OAuth login) - High priority, blocks 2 items, ~13 pts"

// AI analyzes pipeline failures and suggests fixes
await azure_analyze_pipeline_failures({
  project: "MyProject",
  pipeline_id: 42,
})
// Returns: "3/10 runs failed. Recommendations: 1) Review failed builds 2) Check agent config"

// AI decomposes feature into stories
await azure_decompose_feature({
  work_item_id: 150,
})
// Creates 3 user stories with estimates and acceptance criteria
```

### 📚 Confluence Agent Intelligence (24 Tools)

The enterprise proxy includes comprehensive Confluence integration with AI-powered documentation intelligence.

#### Phase 1: Foundation Tools (6)

1. **confluence_get_space_overview** - Complete space overview with page tree structure
2. **confluence_get_page_hierarchy** - Page hierarchy for navigation context
3. **confluence_get_page_comments** - All comments and team discussions
4. **confluence_get_recent_updates** - Recent content updates across spaces
5. **confluence_analyze_page_links** - Page link analysis (incoming/outgoing relationships)
6. **confluence_get_page_metrics** - Engagement metrics (views, likes, shares)

#### Phase 2: Intelligence Tools (6)

7. **confluence_create_documentation** - AI-powered documentation generation with best practices
8. **confluence_improve_content** - AI content analysis and improvement suggestions
9. **confluence_generate_page_summary** - Automatic page summarization
10. **confluence_suggest_related_pages** - Find related content for better navigation
11. **confluence_analyze_documentation_gaps** - Identify missing documentation
12. **confluence_standardize_formatting** - Automated formatting standardization

#### Phase 3: Optimization Tools (4)

13. **confluence_bulk_update_pages** - Bulk operations on multiple pages
14. **confluence_create_space_report** - Comprehensive space analytics and health reports
15. **confluence_find_duplicate_content** - Detect duplicate or similar pages
16. **confluence_archive_old_content** - Archive outdated content automatically

#### Original Confluence Tools (8)

17. **confluence_create_page** - Create new pages
18. **confluence_update_page** - Update existing pages
19. **confluence_get_page** - Get page details
20. **confluence_search_content** - Search across spaces
21. **confluence_add_comment** - Add comments to pages
22. **confluence_get_space** - Get space information
23. **confluence_create_space** - Create new spaces
24. **confluence_manage_attachments** - Handle page attachments

**Example Usage:**

```javascript
// AI identifies documentation gaps in your space
await confluence_analyze_documentation_gaps({
  space_key: "DEV",
  check_areas: ["API", "Architecture", "Deployment"],
})
// Returns: "Missing: API authentication guide, Database schema docs"

// AI generates comprehensive documentation
await confluence_create_documentation({
  space_key: "DEV",
  title: "REST API Authentication Guide",
  topic: "OAuth 2.0 implementation for our REST API",
  include_code_examples: true,
})
// Creates complete page with structure, examples, and best practices

// AI improves existing content
await confluence_improve_content({
  page_id: "12345",
  aspects: ["clarity", "structure", "completeness"],
})
// Returns suggestions: "Add table of contents, clarify step 3, add troubleshooting section"
```

## Usage

### Automatic (Recommended)

```bash
# During snow-flow auth login
$ snow-flow auth login

? Do you have a Serac Enterprise license? Yes
? Enterprise License Key: SNOW-ENT-CUST-ABC123

✓ Enterprise MCP Proxy configured
✓ snow-code.json updated
```

### Manual Testing

```bash
# Set environment variables
export SNOW_LICENSE_KEY=SNOW-ENT-CUST-ABC123
export SNOW_ENTERPRISE_URL=https://license-server.run.app

# Run proxy directly (for debugging)
node dist/mcp/enterprise-proxy/index.js
```

## Security

### License Key Authentication

- License key sent in `Authorization: Bearer` header
- Server validates format, customer status, and expiration
- Rate limiting: 100 requests / 15 minutes per customer

### Credentials

**Option 1: Local (in environment)**

- Credentials read from environment variables
- Sent to server in HTTPS request body (encrypted in transit)
- Simple setup, no server-side configuration needed

**Option 2: Server-side (encrypted)**

- Credentials stored encrypted in enterprise server database
- Not sent in requests, server uses own credentials
- Requires SSO configuration, most secure option

### Machine Fingerprinting

- Unique machine ID generated via `node-machine-id`
- Sent in `X-Instance-ID` header for seat tracking
- Privacy-preserving (hashed, not actual MAC addresses)

## Error Handling

The proxy handles common errors gracefully:

- **401 Unauthorized**: Invalid or expired license key
- **403 Forbidden**: Access denied, check license status
- **404 Not Found**: Tool not found in enterprise catalog
- **429 Too Many Requests**: Rate limit exceeded
- **ECONNREFUSED**: Cannot connect to enterprise server
- **ETIMEDOUT**: Request timeout (2 minutes)

## Development

### Building

```bash
npm run build
```

### Testing

```bash
# Unit tests
npm test

# Integration test with mock server
npm run test:integration
```

## License

Open Source (Elastic License v2)
Part of the Serac platform
