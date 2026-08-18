import type { Catalogue } from "./catalogue";

/**
 * Russian.
 *
 * Typed as `Catalogue`, so a key added to English and not translated here is a
 * build error rather than an English word appearing mid-sentence on someone's
 * screen.
 *
 * Kubernetes vocabulary is left alone on purpose — «под», not «pod», is a word
 * Russian-speaking operators do use in speech, but the interface has to agree
 * with `kubectl get pods` and with what they will search for. Counted nouns
 * therefore carry the Russian forms of the *word* while the kind names stay as
 * the API spells them.
 */
export const ru: Catalogue = {
  nav: {
    overview: "Обзор",
    workloads: "Нагрузки",
    cluster: "Кластер",
    network: "Сеть",
    storage: "Хранилище",
    config: "Конфигурация",
    integrations: "Интеграции",
    app: "Приложение",
    settings: "Настройки",
  },
  columns: {
    name: "Имя",
    namespace: "Пространство имён",
    age: "Возраст",
    memory: "Память",
    capacity: "Объём",
    accessModes: "Режимы доступа",
    replicas: "Реплики",
    keys: "Ключи",
    status: "Состояние",
    ready: "Готовность",
    restarts: "Перезапуски",
    node: "Узел",
    strategy: "Стратегия",
    desired: "Требуется",
    current: "Запущено",
    completions: "Выполнено",
    schedule: "Расписание",
    suspend: "Пауза",
    active: "Активных",
    lastSchedule: "Последний запуск",
    type: "Тип",
    ports: "Порты",
    class: "Класс",
    hosts: "Хосты",
    paths: "Пути",
    address: "Адрес",
    roles: "Роли",
    version: "Версия",
    internalIp: "Внутренний IP",
    cpuUsage: "Загрузка CPU",
    memoryUsage: "Память",
    podCap: "Лимит подов",
    reclaimPolicy: "Освобождение",
    bindingMode: "Режим привязки",
    expansion: "Расширение",
    parameters: "Параметры",
    delivery: "Доставка",
  },
  action: {
    cancel: "Отмена",
    close: "Закрыть",
    save: "Сохранить",
    delete: "Удалить",
    retry: "Повторить",
    refresh: "Обновить",
    copy: "Копировать",
    copied: "Скопировано",
    manage: "Управление",
    openInBrowser: "Открыть в браузере",
    back: "Назад",
  },
  activity: {
    title: "Активность",
    idle: "активность",
    ports: "Порты",
    terminals: "Терминалы",
    jobs: "Задачи",
    // Three forms, and the plural rule picks between them by the number:
    // 1 проброс, 2 проброса, 5 пробросов, 21 проброс.
    portForwards: {
      one: "{n} проброс",
      few: "{n} проброса",
      many: "{n} пробросов",
      other: "{n} проброса",
    },
    terminalCount: {
      one: "{n} терминал",
      few: "{n} терминала",
      many: "{n} терминалов",
      other: "{n} терминала",
    },
    jobCount: {
      one: "{n} задача",
      few: "{n} задачи",
      many: "{n} задач",
      other: "{n} задачи",
    },
    active: "активных: {n}",
  },
  cluster: {
    notConnected: "Кластер не подключён",
    connecting: "Подключение…",
    signInAgain: "Войти снова",
    podCount: {
      one: "{n} под",
      few: "{n} пода",
      many: "{n} подов",
      other: "{n} пода",
    },
    problemCount: {
      one: "{n} проблема",
      few: "{n} проблемы",
      many: "{n} проблем",
      other: "{n} проблемы",
    },
  },
  settings: {
    language: "Язык",
    languageHint:
      "Язык интерфейса. Имена и статусы Kubernetes остаются такими, как их пишет кластер.",
    systemLanguage: "Как в системе",
  },
  empty: {
    noPodsForJob: "У этой задачи нет подов",
    noEventsForClaim: "Для этой заявки нет событий",
    none: "Нет",
    noLabels: "Меток нет",
    noAnnotations: "Аннотаций нет",
    noFinalizers: "Финализаторов нет",
    noOwner: "У объекта нет владельца — он создан напрямую.",
    noConditions: "Условий нет",
    noEventsForObject: "Событий для этого объекта нет",
    noEventsUnprovisioned:
      "Событий пока нет — ни один provisioner не взял этот claim в работу.",
    nothingScheduled: "ничего не запланировано",
    scaledToZero: "масштабирован до нуля",
    noResourcesInScope: "В текущей области нет объектов этого типа.",
    nothingMatches: "Ничего не найдено по запросу",
    noDataKeys: "Ключей данных нет",
    nothingBelongsToObject: "Этому объекту не принадлежит ничего такого рода.",
    deploymentHasNoReplicaSets: "У этого Deployment нет ни одного ReplicaSet",
    cronJobNotRunYet: "Этот CronJob ещё не запускался",
    noPodsForWorkload: "У этой нагрузки нет подов",
    kindHoldsNoKeys: "В {kind} нет ключей",
    kindHasNoPods: "У {kind} сейчас нет подов",
    revisionHasNoPods: "У этой ревизии сейчас нет подов",
    noPodsSuperseded: "Подов нет — эту ревизию сменила ревизия {revision}.",
    noPodsScaledToZero: "Подов нет — Deployment масштабирован до нуля.",
    noConditionsReplicaSet:
      "Этот ReplicaSet ничего не сообщил — условие появляется, только когда он не может создать под.",
    noSelectorDaemonSet: "Селектора нет — этот DaemonSet ни с чем не совпадает",
    noSelectorService:
      "Селектора нет — этот Service не выбирает поды по меткам",
    noParameters:
      "Параметров нет — provisioner использует свои значения по умолчанию.",
    noLabelsOnNode:
      "На этом узле нет меток — даже набора kubernetes.io/*, который регистрирует kubelet; обычно это значит, что объект не был прочитан.",
    noneInScope: "в этой области нет",
    nothingBroken: "ничего не сломано",
    nothingRunning: "ничего не запущено",
    usageIdleNote:
      "Потребление суммируется по запущенным подам, а metrics-server ничего не хранит о завершившемся поде — поэтому линии нет вовсе, а не линия на нуле.",
    kindScaledToZero: "{kind} масштабирован до нуля.",
    kindNoPodsRunning: "Ни один под этого {kind} не запущен.",
    daemonSetNoNodeMatches:
      "Ни один узел не подходит этому DaemonSet, поэтому подов он не разместил.",
    cronJobSuspended: "Этот CronJob приостановлен, поэтому запусков не будет.",
    cronJobNoRunInFlight:
      "Сейчас не выполняется ни одного запуска этого CronJob.",
    jobFinished: "Этот Job завершён.",
    jobNoPodRunningFailed:
      "Ни один под этого Job не запущен, а последний завершился с ошибкой.",
    jobNoPodRunning: "Ни один под этого Job не запущен.",
    noPodsToReadLogs:
      "У этого Deployment нет подов, из которых можно читать логи.",
    podMountsNothing: "Этот под не монтирует ничего своего.",
    noContainersInSpec:
      "В этой спецификации нет контейнеров — смотреть нечего, и ни образ, ни пробу читать неоткуда.",
    noEnvVarsMatchFilter:
      "Под выбранный фильтр не подходит ни одна переменная окружения",
    nothingReadForService: "Для этого Service ничего не прочитано.",
    servicePublishesNothing:
      "Этот Service не публикует ни одного адреса — до него ничего не доходит.",
    noSchemaInfo: "Сведений о схеме нет.",
    noContextNeedsPlugin: "Ни одному контексту он не нужен.",
    noneRead: "Ничего не прочитано.",
    fileNamesNoContexts: "В этом файле не назван ни один контекст",
    fileNamesNoContextsBody:
      "Файл выше разобран, и подключаться в нём не к чему. Либо это не тот kubeconfig, который вы имели в виду, либо контексты в него так и не записали — укажите приложению другой файл, чтобы проверить.",
    configHasNoClusters: "В файле конфигурации нет кластеров",
    configHasNoClustersSub:
      "Файл прочитан, но в нём нет контекста для подключения.",
    notConnectedYet: "Вы ещё не подключены к кластеру",
    noKubeconfigFound: "На этой машине не найдено конфигурации кластера.",
    noClusterIsConnected: "Кластер не подключён",
    kindReadFromCluster:
      "{kind} читаются из кластера, а это окно пока ни к одному не подключено.",
    notOnClusterYet: "Это окно пока не подключено к кластеру.",
    kubeconfigListsNoClusters: "В вашем kubeconfig кластеров тоже нет.",
    noClusterMatchesNeedle:
      "Ни один кластер в kubeconfig не отзывается на «{needle}».",
    noMatchesYet:
      "Совпадений пока нет — ответили {answered} из {total} кластеров.",
    nothingSearchedNoCluster:
      "Поиск не выполнялся: ни один кластер ещё не подключён.",
    nothingMatchesOnSearched:
      "По запросу «{query}» ничего не найдено на {answered} из {total} кластеров, где выполнялся поиск.",
    nothingMatchesQuery: "По запросу «{query}» ничего не найдено.",
    noHelmHistory: "Истории нет — Helm её для этого релиза не хранит.",
    nothingRoutesThroughController:
      "Через этот контроллер ничего не проходит, поэтому рисовать нечего.",
    noIntegrationByName: "Интеграции с таким именем нет",
    noIntegrationByNameBody:
      "В приложении нет страницы для «{slug}». Название могло измениться, либо ссылка из более новой версии.",
    integrationNotInstalled: "{name} не установлен в этом кластере",
    integrationNotInstalledBody:
      "Его CustomResourceDefinition нет на этом API-сервере, поэтому странице нечего читать. Любое расширение необязательно — кластер работает ровно так же, как сейчас.",
    integrationNotConnected: "{name} не подключён",
    integrationNotConnectedBody:
      "Он ничего не устанавливает в кластер, поэтому обнаруживать нечего — он работает по адресу, который вы задаёте приложению и который хранится для каждого кластера. Укажите адрес, и страница оживёт.",
    noProfilesGcp:
      "Профилей нет — используются Application Default Credentials.",
    noProfilesAzure:
      "Профилей нет — используются учётные данные az login по умолчанию.",
    noCrdsInCluster: "В этом кластере нет ни одного CustomResourceDefinition.",
    crdNoInstances: "CRD установлен, но ни один {kind} ещё не создан.",
    crdNoInstancesInNamespace:
      "CRD установлен, но в {namespace} ещё не создан ни один {kind}.",
    nothingManagesSecret:
      "В этом пространстве имён этим Secret никто не управляет, поэтому сам он не обновится — заменяет его тот, кто положил сюда сертификат.",
    nothingWrong: "Здесь всё в порядке",
    noResults: "Ничего не найдено",
  },
  count: {
    keys: {
      one: "{n} ключ",
      few: "{n} ключа",
      many: "{n} ключей",
      other: "{n} ключа",
    },
    items: {
      one: "{n} элемент",
      few: "{n} элемента",
      many: "{n} элементов",
      other: "{n} элемента",
    },
    fields: {
      one: "{n} поле",
      few: "{n} поля",
      many: "{n} полей",
      other: "{n} поля",
    },
    settingsMatch: {
      one: "{n} настройка подходит",
      few: "{n} настройки подходят",
      many: "{n} настроек подходит",
      other: "{n} настройки подходят",
    },
    volumes: {
      one: "{n} том",
      few: "{n} тома",
      many: "{n} томов",
      other: "{n} тома",
    },
    paths: {
      one: "{n} путь",
      few: "{n} пути",
      many: "{n} путей",
      other: "{n} пути",
    },
    hosts: {
      one: "{n} хост",
      few: "{n} хоста",
      many: "{n} хостов",
      other: "{n} хоста",
    },
    resources: {
      one: "{n} ресурс",
      few: "{n} ресурса",
      many: "{n} ресурсов",
      other: "{n} ресурса",
    },
    releases: {
      one: "{n} релиз",
      few: "{n} релиза",
      many: "{n} релизов",
      other: "{n} релиза",
    },
    contexts: {
      one: "{n} контекст",
      few: "{n} контекста",
      many: "{n} контекстов",
      other: "{n} контекста",
    },
    apiGroups: {
      one: "{n} API-группа",
      few: "{n} API-группы",
      many: "{n} API-групп",
      other: "{n} API-группы",
    },
    loadBalancers: {
      one: "{n} балансировщик",
      few: "{n} балансировщика",
      many: "{n} балансировщиков",
      other: "{n} балансировщика",
    },
    queriesRefused: {
      one: "{n} запрос отклонён",
      few: "{n} запроса отклонены",
      many: "{n} запросов отклонено",
      other: "{n} запроса отклонены",
    },
    failedPods: {
      one: "{n} упавший под",
      few: "{n} упавших пода",
      many: "{n} упавших подов",
      other: "{n} упавших пода",
    },
    summedOverPods: {
      one: "суммарно по {n} поду",
      few: "суммарно по {n} подам",
      many: "суммарно по {n} подам",
      other: "суммарно по {n} подам",
    },
    replicasWanted: {
      one: "реплика требуется",
      few: "реплики требуются",
      many: "реплик требуется",
      other: "реплики требуются",
    },
    completionsWanted: {
      one: "завершение требуется",
      few: "завершения требуются",
      many: "завершений требуется",
      other: "завершения требуются",
    },
    retryNoun: {
      one: "повтор",
      few: "повтора",
      many: "повторов",
      other: "повтора",
    },
    lineNoun: { one: "строка", few: "строки", many: "строк", other: "строки" },
    errorNoun: {
      one: "ошибка",
      few: "ошибки",
      many: "ошибок",
      other: "ошибки",
    },
    warningNoun: {
      one: "предупреждение",
      few: "предупреждения",
      many: "предупреждений",
      other: "предупреждения",
    },
    inSliceCount: {
      one: "в {n} срезе",
      few: "в {n} срезах",
      many: "в {n} срезах",
      other: "в {n} срезах",
    },
    restartNoun: {
      one: "перезапуск",
      few: "перезапуска",
      many: "перезапусков",
      other: "перезапуска",
    },
    ofTotal: "{n} из {total}",
    ofTotalReady: "{n} из {total} готовы",
  },
};
