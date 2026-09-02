{{/*
Chart name and release-scoped full name.
*/}}
{{- define "maritime.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "maritime.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "maritime.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/*
Common labels for every object of the chart.
*/}}
{{- define "maritime.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/part-of: maritime
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
maritime.io/environment: {{ .Values.global.environment | quote }}
{{- end -}}

{{/*
Selector labels for one service. Expects a dict with `root` (top-level context) and `svc` (the service entry).
*/}}
{{- define "maritime.selectorLabels" -}}
app.kubernetes.io/name: {{ .svc.name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end -}}

{{/*
Fully qualified image reference for a service entry: [registry/]repository:tag.
*/}}
{{- define "maritime.image" -}}
{{- $registry := .root.Values.global.imageRegistry -}}
{{- $tag := default .root.Values.global.imageTag .svc.tag -}}
{{- if $registry -}}
{{- printf "%s/%s:%s" $registry .svc.image $tag -}}
{{- else -}}
{{- printf "%s:%s" .svc.image $tag -}}
{{- end -}}
{{- end -}}

{{/*
Secret key that carries a service's DATABASE_URL: DATABASE_URL_<NAME> with dashes as underscores, upper case.
*/}}
{{- define "maritime.databaseKey" -}}
{{- printf "DATABASE_URL_%s" (.name | replace "-" "_" | upper) -}}
{{- end -}}
