# Placeholder outputs: replaced by the provider-specific implementation (secret manager entries synced to Kubernetes).
output "secret_names" {
  description = "Provisioned secret names."
  value       = var.secret_names
}
