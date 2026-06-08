/**
 * Knowledge Management Tools
 *
 * Tools for managing ServiceNow Knowledge Base articles, knowledge bases,
 * categories, and search functionality.
 */

// Legacy tools (kept for backward compatibility)
export {
  toolDefinition as snow_create_catalog_item_def,
  execute as snow_create_catalog_item_exec,
} from "./snow_create_catalog_item.js"

// Merged Knowledge Article Management (v8.2.0)
// Replaces: create, update, get_details, publish, retire, search (6 → 1)
export {
  toolDefinition as snow_knowledge_article_manage_def,
  execute as snow_knowledge_article_manage_exec,
} from "./snow_knowledge_article_manage.js"

// Knowledge Base Management
export {
  toolDefinition as snow_create_knowledge_base_def,
  execute as snow_create_knowledge_base_exec,
} from "./snow_create_knowledge_base.js"
export {
  toolDefinition as snow_discover_knowledge_bases_def,
  execute as snow_discover_knowledge_bases_exec,
} from "./snow_discover_knowledge_bases.js"
