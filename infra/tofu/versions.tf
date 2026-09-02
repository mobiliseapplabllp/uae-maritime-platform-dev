# OpenTofu skeleton for the maritime platform. Cloud-agnostic on purpose: the root wires five modules
# (network, kubernetes, postgres, object-storage, secrets) whose implementations are chosen per hosting
# provider when the target cloud is confirmed. No provider credentials live here; the backend is configured
# per environment with `tofu init -backend-config=<env>.tfbackend`.
terraform {
  required_version = ">= 1.8.0"

  backend "local" {}
}
