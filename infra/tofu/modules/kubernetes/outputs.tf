# Placeholder outputs: replaced by the provider-specific implementation (managed Kubernetes, node pools, ingress).
output "cluster_name" {
  description = "Cluster name."
  value       = var.cluster.name
}

output "cluster_endpoint" {
  description = "API server endpoint."
  value       = null
  sensitive   = true
}

output "namespace" {
  description = "Namespace the maritime chart is installed into."
  value       = var.cluster.namespace
}
