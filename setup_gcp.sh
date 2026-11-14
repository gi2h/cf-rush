#!/usr/bin/env bash
set -euo pipefail

# Project can be supplied as PROJECT_ID or inherited from gcloud config.
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"

# This workflow is specific to gi2h/cf-rush.
GITHUB_ORG="${GITHUB_ORG:-gi2h}"
GITHUB_REPO="${GITHUB_REPO:-cf-rush}"

REGION="${REGION:-asia-southeast1}"
SA_NAME="${SA_NAME:-cf-rush-deployer}"
POOL_ID="${POOL_ID:-cf-rush-pool}"
PROVIDER_ID="${PROVIDER_ID:-cf-rush-provider}"
AR_REPOSITORY="${AR_REPOSITORY:-cf-rush}"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "ERROR: gcloud CLI is not installed." >&2
  exit 1
fi

if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
  echo "ERROR: PROJECT_ID is not set. Export PROJECT_ID or set a default gcloud project." >&2
  exit 1
fi

SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "Project:     ${PROJECT_ID}"
echo "GitHub repo: ${GITHUB_ORG}/${GITHUB_REPO}"
echo "Region:      ${REGION}"
echo "Deployer SA: ${SA_EMAIL}"
echo

# 1. Enable required APIs.
echo "Enabling APIs..."
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  iamcredentials.googleapis.com \
  iam.googleapis.com \
  sts.googleapis.com \
  cloudresourcemanager.googleapis.com \
  --project="${PROJECT_ID}"

# 2. Create the deployer service account and grant required roles.
if ! gcloud iam service-accounts describe "${SA_EMAIL}" \
  --project="${PROJECT_ID}" >/dev/null 2>&1; then

  gcloud iam service-accounts create "${SA_NAME}" \
    --project="${PROJECT_ID}" \
    --display-name="GitHub Actions deployer for cf-rush"
fi

for role in \
  roles/run.admin \
  roles/iam.serviceAccountUser \
  roles/artifactregistry.writer
do
  echo "Granting ${role}..."
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="${role}" \
    --quiet >/dev/null
done

# 3. Create the Artifact Registry Docker repository.
echo "Ensuring Artifact Registry repository exists..."
if ! gcloud artifacts repositories describe "${AR_REPOSITORY}" \
  --project="${PROJECT_ID}" \
  --location="${REGION}" >/dev/null 2>&1; then

  gcloud artifacts repositories create "${AR_REPOSITORY}" \
    --project="${PROJECT_ID}" \
    --location="${REGION}" \
    --repository-format=docker \
    --description="Docker images for cf-rush"
fi

# 4. Create the Workload Identity Pool.
echo "Ensuring Workload Identity Pool exists..."
if ! gcloud iam workload-identity-pools describe "${POOL_ID}" \
  --project="${PROJECT_ID}" \
  --location="global" >/dev/null 2>&1; then

  gcloud iam workload-identity-pools create "${POOL_ID}" \
    --project="${PROJECT_ID}" \
    --location="global" \
    --display-name="GitHub Actions for cf-rush"
fi

# 5. Create or reconcile the GitHub OIDC provider.
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" \
  --format="value(projectNumber)")"

if [[ -z "${PROJECT_NUMBER}" ]]; then
  echo "ERROR: Could not determine project number." >&2
  exit 1
fi

PROVIDER_ARGS=(
  "--project=${PROJECT_ID}"
  "--location=global"
  "--workload-identity-pool=${POOL_ID}"
  "--display-name=GitHub Actions OIDC for cf-rush"
  "--issuer-uri=https://token.actions.githubusercontent.com"
  "--attribute-mapping=google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner,attribute.ref=assertion.ref"
  "--attribute-condition=assertion.repository == '${GITHUB_ORG}/${GITHUB_REPO}'"
)

echo "Configuring Workload Identity Provider..."
if gcloud iam workload-identity-pools providers describe "${PROVIDER_ID}" \
  --project="${PROJECT_ID}" \
  --location="global" \
  --workload-identity-pool="${POOL_ID}" >/dev/null 2>&1; then

  gcloud iam workload-identity-pools providers update-oidc "${PROVIDER_ID}" \
    "${PROVIDER_ARGS[@]}" \
    --quiet
else
  gcloud iam workload-identity-pools providers create-oidc "${PROVIDER_ID}" \
    "${PROVIDER_ARGS[@]}"
fi

# 6. Allow only this GitHub repository to impersonate the deployer SA.
WIF_PRINCIPAL="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository/${GITHUB_ORG}/${GITHUB_REPO}"

echo "Binding GitHub repository to deployer service account..."
gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
  --project="${PROJECT_ID}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="${WIF_PRINCIPAL}" \
  --quiet >/dev/null

# 7. Output the three GitHub Actions values.
WIF_PROVIDER="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"

echo
echo "============================================================"
echo "Add these values to GitHub repository secrets:"
echo "============================================================"
printf 'GCP_PROJECT_ID=%s\n' "${PROJECT_ID}"
printf 'GCP_SERVICE_ACCOUNT=%s\n' "${SA_EMAIL}"
printf 'GCP_WIF_PROVIDER=%s\n' "${WIF_PROVIDER}"
