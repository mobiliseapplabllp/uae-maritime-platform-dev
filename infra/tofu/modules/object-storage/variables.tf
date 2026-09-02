variable "name" {
  description = "Resource name prefix."
  type        = string
}

variable "region" {
  description = "Hosting region."
  type        = string
}

variable "buckets" {
  description = "Bucket short names; the prefix is prepended."
  type        = list(string)
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}
