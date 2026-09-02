variable "name" {
  description = "Resource name prefix."
  type        = string
}

variable "region" {
  description = "Hosting region."
  type        = string
}

variable "cidr" {
  description = "Address space of the network."
  type        = string
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}
