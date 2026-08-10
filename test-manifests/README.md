# K8s GUI Test Manifests

Тестовые манифесты для проверки всех функций k8s-gui.

## Быстрый старт

```bash
# Применить все ресурсы
kubectl apply -f comprehensive-test.yaml

# Проверить статус
kubectl get all -n k8s-gui-test

# Удалить все ресурсы
kubectl delete -f comprehensive-test.yaml
kubectl delete pv k8s-gui-test-pv
```

## Что создаётся

### Namespace

- `k8s-gui-test` — изолированный namespace для тестов

### Configuration (Config & Storage → Configuration)

| Ресурс    | Имя                     | Описание                                      |
| --------- | ----------------------- | --------------------------------------------- |
| ConfigMap | `app-config`            | Простые key-value данные                      |
| ConfigMap | `nginx-config`          | Многострочные данные (nginx.conf, index.html) |
| Secret    | `app-secrets`           | Opaque secret с credentials                   |
| Secret    | `docker-registry-creds` | kubernetes.io/dockerconfigjson                |
| Secret    | `tls-secret`            | kubernetes.io/tls                             |

### Storage

| Ресурс                | Имя               | Описание          |
| --------------------- | ----------------- | ----------------- |
| PersistentVolume      | `k8s-gui-test-pv` | hostPath PV (1Gi) |
| PersistentVolumeClaim | `data-pvc`        | PVC (500Mi)       |

### Workloads

| Ресурс      | Имя             | Реплики | Описание                            |
| ----------- | --------------- | ------- | ----------------------------------- |
| Deployment  | `frontend`      | 2       | nginx с ConfigMap volume            |
| Deployment  | `backend`       | 3       | http-echo с env из ConfigMap/Secret |
| Deployment  | `worker`        | 2       | busybox с логами                    |
| StatefulSet | `redis`         | 3       | Redis с volumeClaimTemplates        |
| DaemonSet   | `log-collector` | \*      | На каждой ноде                      |
| Job         | `db-migration`  | -       | Одноразовая задача                  |
| CronJob     | `backup-job`    | -       | Каждые 5 минут                      |

### Pods (standalone)

| Имя           | Контейнеры                      | Описание                                   |
| ------------- | ------------------------------- | ------------------------------------------ |
| `debug-pod`   | main (nginx), sidecar (busybox) | Для тестирования логов, exec, port-forward |
| `failing-pod` | failing                         | Падает каждые 10 секунд                    |
| `init-pod`    | init-wait, main                 | Init container demo                        |

### Network

| Ресурс    | Имя                 | Тип                  | Описание              |
| --------- | ------------------- | -------------------- | --------------------- |
| Service   | `frontend`          | ClusterIP            | Frontend service      |
| Service   | `backend`           | ClusterIP            | Backend service       |
| Service   | `frontend-nodeport` | NodePort             | Port 30080            |
| Service   | `backend-lb`        | LoadBalancer         | External access       |
| Service   | `redis-headless`    | ClusterIP (headless) | Для StatefulSet       |
| Service   | `external-api`      | ExternalName         | api.example.com       |
| Service   | `external-db`       | ClusterIP            | Для manual endpoints  |
| Ingress   | `main-ingress`      | -                    | С TLS, paths: /, /api |
| Ingress   | `api-ingress`       | -                    | Без TLS, path rewrite |
| Endpoints | `external-db`       | -                    | Manual endpoints      |

## Что можно тестировать

### List views

- [ ] Pods — разные статусы (Running, CrashLoopBackOff, Init)
- [ ] Deployments — разное количество реплик
- [ ] StatefulSets — ordered pods (redis-0, redis-1, redis-2)
- [ ] DaemonSets — pods на каждой ноде
- [ ] Jobs — completed/running jobs
- [ ] CronJobs — scheduled jobs
- [ ] Services — все типы (ClusterIP, NodePort, LoadBalancer, ExternalName, Headless)
- [ ] Ingresses — с TLS и без
- [ ] ConfigMaps — простые и многострочные данные
- [ ] Secrets — разные типы (Opaque, dockerconfigjson, tls)
- [ ] PersistentVolumes — cluster-scoped
- [ ] PersistentVolumeClaims — bound/pending
- [ ] Endpoints — auto-created и manual

### Detail pages

- [ ] Pod detail — containers, volumes, env vars
- [ ] Deployment detail — replicas, strategy, conditions
- [ ] Service detail — endpoints, selectors
- [ ] Ingress detail — rules, TLS, backends

### Actions

- [ ] **Logs** — `debug-pod` (2 контейнера с логами)
- [ ] **Exec/Terminal** — `debug-pod` (nginx + busybox)
- [ ] **Port Forward** — `debug-pod:80`, `backend:8080`
- [ ] **Scale** — `frontend`, `backend` deployments
- [ ] **Restart** — любой deployment
- [ ] **Delete** — любой ресурс
- [ ] **View YAML** — все ресурсы
- [ ] **Edit YAML** — ConfigMaps, Secrets, Deployments
- [ ] **View Data** — Secrets (app-secrets)
- [ ] **Copy Keys** — Secrets

### Events

- [ ] Pod events — создание, scheduling
- [ ] Warning events — `failing-pod` crashes

### Filtering

- [ ] Namespace filter — `k8s-gui-test`
- [ ] Label selector — `app=k8s-gui-test`
- [ ] Status filter — Running, Pending, Failed
- [ ] Service type filter — ClusterIP, NodePort, LoadBalancer
- [ ] Secret type filter — Opaque, tls, dockerconfigjson

---

## Тестирование Helm

### Установка тестовых Helm релизов

```bash
# Запустить скрипт для установки тестовых релизов
./helm-test.sh

# Или вручную:
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update

# Установить тестовые релизы
helm install redis-test bitnami/redis -n helm-test --create-namespace \
    --set architecture=standalone --set auth.enabled=false \
    --set master.persistence.enabled=false

helm install nginx-test bitnami/nginx -n helm-test \
    --set replicaCount=2 --set service.type=ClusterIP
```

### Проверка в k8s-gui

1. Откройте приложение
2. Перейдите в **Plugins → Helm**
3. Убедитесь что релизы отображаются
4. Проверьте:
   - [ ] Список релизов с фильтром по namespace
   - [ ] Статусы (deployed, pending-install, failed)
   - [ ] Детальная страница (клик на релиз)
   - [ ] История ревизий
   - [ ] Rollback (если несколько ревизий)
   - [ ] Uninstall с подтверждением

### Удаление тестовых релизов

```bash
helm uninstall redis-test nginx-test -n helm-test
kubectl delete namespace helm-test
```

---

## Тестирование CRDs (Traefik, Istio, Cert-Manager)

### Установка CRD определений

```bash
# Применить CRD определения (без установки самих контроллеров)
kubectl apply -f crds-traefik-istio.yaml
```

### Создание тестовых ресурсов

```bash
# Применить тестовые Custom Resources
kubectl apply -f crd-resources-test.yaml
```

### Что создаётся

| CRD Group               | Resources                                              |
| ----------------------- | ------------------------------------------------------ |
| **traefik.io**          | IngressRoute, Middleware, TraefikService               |
| **networking.istio.io** | VirtualService, DestinationRule, Gateway, ServiceEntry |
| **cert-manager.io**     | Certificate, ClusterIssuer                             |

### Проверка в k8s-gui

1. Перейдите в **Cluster → CRDs**
2. Найдите установленные CRDs:
   - `ingressroutes.traefik.io`
   - `virtualservices.networking.istio.io`
   - `certificates.cert-manager.io`
3. Кликните на CRD для просмотра ресурсов
4. Проверьте:
   - [ ] Список всех CRD в кластере
   - [ ] Фильтрация по группе (traefik.io, networking.istio.io)
   - [ ] Просмотр Custom Resources внутри CRD
   - [ ] Детали CR (YAML, metadata)

### Удаление тестовых CRDs

```bash
kubectl delete -f crd-resources-test.yaml
kubectl delete -f crds-traefik-istio.yaml
```

---

## Loki (интеграция `logs.history`)

`loki-stack.yaml` поднимает Loki (single binary, filesystem, retention 72h) и
Promtail рядом с демо-Prometheus в namespace `monitoring`. Это то, что читает
лог-вьюер, когда пода уже нет: `--previous` даёт ровно один прошлый запуск и
только пока объект пода жив.

```bash
# перед установкой: Promtail открывает inotify-instance на каждую директорию
sudo sysctl -w fs.inotify.max_user_instances=1024

kubectl apply -f loki-stack.yaml
kubectl -n monitoring rollout status deploy/loki

# адрес для Settings -> Integrations -> Loki -> Connect
echo "http://$(kubectl get node -o jsonpath='{.items[0].status.addresses[0].address}'):30310"

kubectl delete -f loki-stack.yaml   # удалить
```

Метки, по которым спрашивает приложение — `namespace` и `pod` (см.
`src/integrations/loki/queries.ts`). Если в вашей установке Promtail/Alloy
переименовывает их, вьюер честно скажет, какие метки он пробовал, вместо
пустой панели.

---

## Troubleshooting

### StatefulSet pending

Если redis pods в Pending — возможно нет default StorageClass:

```bash
kubectl get sc
# Если пусто, создайте локальный:
kubectl apply -f - <<EOF
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: standard
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
EOF
```

### LoadBalancer pending

В локальном кластере (minikube/kind) LoadBalancer будет в Pending. Это нормально.
Для minikube: `minikube tunnel`

### Ingress не работает

Убедитесь что установлен ingress controller:

```bash
# Для minikube
minikube addons enable ingress

# Для kind
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
```

### Helm релизы не отображаются

1. Проверьте что Helm CLI установлен: `helm version`
2. Проверьте наличие секретов: `kubectl get secrets -l owner=helm --all-namespaces`
3. Если секреты есть но релизы не видны — проверьте логи приложения

### CRDs не отображаются

1. Проверьте что CRDs созданы: `kubectl get crds`
2. Убедитесь что у вас есть права на просмотр CRDs
