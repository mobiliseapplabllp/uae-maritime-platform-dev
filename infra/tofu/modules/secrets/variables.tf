variable "name" {
  description = "Resource name prefix."
  type        = string
}

variable "region" {
  description = "Hosting region."
  type        = string
}

variable "secret_names" {
  description = "Secret names to provision (values are set out of band)."
  type        = list(string)
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}
