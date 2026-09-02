# Placeholder outputs: replaced by the provider-specific implementation (versioned, encrypted, private buckets).
output "bucket_names" {
  description = "Fully qualified bucket names."
  value       = [for b in var.buckets : "${var.name}-${b}"]
}
