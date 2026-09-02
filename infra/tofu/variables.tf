variable "region" {
  description = "Hosting region identifier (provider-specific string, e.g. me-central-1)."
  type        = string
}

variable "environment" {
  description = "Deployment environment name."
  type        = string

  validation {
    condition     = contains(["dev", "uat", "prod"], var.environment)
    error_message = "environment must be one of dev, uat, prod."
  }
}

variable "kubernetes_cluster" {
  description = "Reference to the Kubernetes cluster the platform is deployed to (created by the kubernetes module or pre-existing)."
  type = object({
    name          = string
    version       = optional(string, "1.30")
    node_count    = optional(number, 3)
    node_size     = optional(string, "medium")
    existing      = optional(bool, false)
    namespace     = optional(string, "maritime")
    ingress_class = optional(string, "nginx")
  })
}

variable "database_tier" {
  description = "Sizing tier of the managed PostgreSQL 16 instance that hosts the per-service databases."
  type        = string
  default     = "small"

  validation {
    condition     = contains(["small", "medium", "large"], var.database_tier)
    error_message = "database_tier must be small, medium or large."
  }
}

variable "network_cidr" {
  description = "Address space of the platform network."
  type        = string
  default     = "10.40.0.0/16"
}

variable "object_storage_buckets" {
  description = "Object-storage buckets to provision (documents, evidence, exports, backups)."
  type        = list(string)
  default     = ["documents", "evidence", "exports", "backups"]
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}
