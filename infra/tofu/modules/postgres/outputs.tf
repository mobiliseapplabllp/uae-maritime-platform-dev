# Placeholder outputs: replaced by the provider-specific implementation (managed PostgreSQL 16 with PostGIS and pgvector).
output "endpoint" {
  description = "Host:port of the instance."
  value       = null
}

output "database_names" {
  description = "Databases created on the instance."
  value       = var.databases
}
