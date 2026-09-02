output "network_id" {
  description = "Identifier of the platform network."
  value       = module.network.network_id
}

output "kubernetes_cluster_name" {
  description = "Name of the Kubernetes cluster the Helm chart is deployed to."
  value       = module.kubernetes.cluster_name
}

output "postgres_endpoint" {
  description = "Host:port of the managed PostgreSQL instance."
  value       = module.postgres.endpoint
}

output "object_storage_buckets" {
  description = "Provisioned bucket names."
  value       = module.object_storage.bucket_names
}

output "secret_names" {
  description = "Names of the platform secrets that must be populated out of band."
  value       = module.secrets.secret_names
}
