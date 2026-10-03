#!/bin/bash
# =============================================================================
# Helm Test Script - Create test releases for k8s-gui
# =============================================================================

set -e

echo "🎯 Helm Test Script for k8s-gui"
echo "================================"

# Check if Helm is installed
if ! command -v helm &> /dev/null; then
    echo "❌ Helm is not installed. Please install it first:"
    echo "   brew install helm  # macOS"
    echo "   choco install kubernetes-helm  # Windows"
    exit 1
fi

echo "✅ Helm version: $(helm version --short)"

# Create test namespace
NAMESPACE="helm-test"
echo ""
echo "📦 Creating namespace: $NAMESPACE"
kubectl create namespace $NAMESPACE --dry-run=client -o yaml | kubectl apply -f -

# Add popular Helm repositories
echo ""
echo "📚 Adding Helm repositories..."

helm repo add bitnami https://charts.bitnami.com/bitnami 2>/dev/null || true
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts 2>/dev/null || true
helm repo add grafana https://grafana.github.io/helm-charts 2>/dev/null || true
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx 2>/dev/null || true
helm repo add jetstack https://charts.jetstack.io 2>/dev/null || true
helm repo add traefik https://traefik.github.io/charts 2>/dev/null || true

echo ""
echo "🔄 Updating repositories..."
helm repo update

# Install test releases
echo ""
echo "🚀 Installing test Helm releases..."

# 1. Redis (simple, fast to install)
echo ""
echo "1️⃣ Installing Redis..."
helm upgrade --install redis-test bitnami/redis \
    --namespace $NAMESPACE \
    --set architecture=standalone \
    --set auth.enabled=false \
    --set master.persistence.enabled=false \
    --wait --timeout 2m || echo "⚠️ Redis installation failed (might need more resources)"

# 2. PostgreSQL
echo ""
echo "2️⃣ Installing PostgreSQL..."
helm upgrade --install postgres-test bitnami/postgresql \
    --namespace $NAMESPACE \
    --set auth.postgresPassword=testpassword \
    --set primary.persistence.enabled=false \
    --wait --timeout 2m || echo "⚠️ PostgreSQL installation failed"

# 3. Nginx (simple web server)
echo ""
echo "3️⃣ Installing Nginx..."
helm upgrade --install nginx-test bitnami/nginx \
    --namespace $NAMESPACE \
    --set replicaCount=2 \
    --set service.type=ClusterIP \
    --wait --timeout 2m || echo "⚠️ Nginx installation failed"

# 4. Install something without --wait (pending state)
echo ""
echo "4️⃣ Installing MongoDB (may take a while)..."
helm upgrade --install mongo-test bitnami/mongodb \
    --namespace $NAMESPACE \
    --set architecture=standalone \
    --set auth.enabled=false \
    --set persistence.enabled=false \
    --timeout 30s || echo "⚠️ MongoDB might be still deploying"

echo ""
echo "✅ Helm test releases installation complete!"
echo ""
echo "📊 Check releases:"
echo "   helm list -n $NAMESPACE"
echo ""
echo "🔍 View in k8s-gui:"
echo "   Open k8s-gui and navigate to Plugins → Helm tab"
echo ""
echo "🗑️ To cleanup:"
echo "   helm uninstall redis-test postgres-test nginx-test mongo-test -n $NAMESPACE"
echo "   kubectl delete namespace $NAMESPACE"
