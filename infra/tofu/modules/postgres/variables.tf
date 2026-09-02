variable "name" {
  description = "Resource name prefix."
  type        = string
}

variable "region" {
  description = "Hosting region."
  type        = string
}

variable "tier" {
  description = "Sizing tier: small, medium or large."
  type        = string
}

variable "databases" {
  description = "Databases to create on the instance."
  type        = list(string)
}

variable "extensions" {
  description = "Extensions enabled in every database."
  type        = list(string)
  default     = ["postgis", "vector", "pgcrypto"]
}

variable "network_id" {
  description = "Network the instance is attached to."
  type        = string
  default     = null
}

variable "subnet_ids" {
  description = "Subnets for the private endpoint."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}
