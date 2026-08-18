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
