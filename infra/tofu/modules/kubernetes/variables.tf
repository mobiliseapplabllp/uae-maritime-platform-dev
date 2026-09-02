variable "name" {
  description = "Resource name prefix."
  type        = string
}

variable "region" {
  description = "Hosting region."
  type        = string
}

variable "cluster" {
  description = "Cluster reference (see the root kubernetes_cluster variable)."
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

variable "network_id" {
  description = "Network the cluster is attached to."
  type        = string
  default     = null
}

variable "subnet_ids" {
  description = "Subnets for the node pools."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}
