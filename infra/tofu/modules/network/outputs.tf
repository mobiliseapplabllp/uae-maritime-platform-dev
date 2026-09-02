# Placeholder outputs: replaced by the provider-specific implementation (VPC/VNet, subnets, NAT, private DNS).
output "network_id" {
  description = "Identifier of the network."
  value       = null
}

output "private_subnet_ids" {
  description = "Private subnets for cluster nodes and data services."
  value       = []
}

output "public_subnet_ids" {
  description = "Public subnets for the ingress load balancer."
  value       = []
}
