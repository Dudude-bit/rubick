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
    network: "Сеть",
    storage: "Хранилище",
    configuration: "Конфигурация",
    nodes: "Узлы",
    events: "События",
    helm: "Helm",
    integrations: "Интеграции",
    settings: "Настройки",
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
};
