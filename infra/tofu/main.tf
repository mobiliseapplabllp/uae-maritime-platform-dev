locals {
  name = "maritime-${var.environment}"
  tags = merge({ platform = "maritime", environment = var.environment, managed_by = "opentofu" }, var.tags)

  # One database per service plus Keycloak; mirrors infra/compose/postgres/01-init-databases.sh.
  databases = [
    "maritime_identity", "maritime_mdm", "maritime_audit", "maritime_notifications", "maritime_scheduler",
    "maritime_reporting", "maritime_workflow", "maritime_rules", "maritime_instruments", "maritime_documents",
    "maritime_integration", "maritime_ships", "maritime_seafarers", "maritime_legislation", "maritime_centre",
    "maritime_inspection", "maritime_ports", "maritime_facilities", "maritime_revenue", "maritime_ai", "keycloak",
  ]
}

module "network" {
  source = "./modules/network"

  name   = local.name
  region = var.region
  cidr   = var.network_cidr
  tags   = local.tags
}

module "kubernetes" {
  source = "./modules/kubernetes"

  name       = local.name
  region     = var.region
  cluster    = var.kubernetes_cluster
  network_id = module.network.network_id
  subnet_ids = module.network.private_subnet_ids
  tags       = local.tags
}

module "postgres" {
  source = "./modules/postgres"

  name       = local.name
  region     = var.region
  tier       = var.database_tier
  databases  = local.databases
  extensions = ["postgis", "vector", "pgcrypto"]
  network_id = module.network.network_id
  subnet_ids = module.network.private_subnet_ids
  tags       = local.tags
}

module "object_storage" {
  source = "./modules/object-storage"

  name    = local.name
  region  = var.region
  buckets = var.object_storage_buckets
  tags    = local.tags
}

module "secrets" {
  source = "./modules/secrets"

  name   = local.name
  region = var.region
  # Secret names the platform expects; values are set out of band, never in git.
  secret_names = concat(
    [for db in local.databases : "DATABASE_URL_${upper(db)}"],
    ["SERVICE_TOKEN", "JWT_SECRET", "KC_GATEWAY_CLIENT_SECRET", "UAEPASS_CLIENT_SECRET"],
  )
  tags = local.tags
}
