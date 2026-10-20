# Этап 6: знания в окне игрока

Реализован только этап 6. База: `origin/main` `354f565b498093f42123a697cc77d8bc1b3dcdc3`; продолжение этапа 5 в `codex/dev` `50dde751f147310985f5acfe740107412bf54f2c`. Независимое ревью и интеграция в test выполняются отдельно. Этапы 7–11 не начинались; алгоритмов выбора, применения крафта и автооткрытия нет.

## Публичный контракт Fabricate 1.9.10

Проверены оригинальные исходники commit `5bf36ddf950619317e41737acd3bfa1305591a26`. Fabricate не изменяется и не собирается.

- После `game.fabricate.whenReady()` каждый клиент один раз вызывает `game.fabricate.api.playerExtensions.registerPlayerNavProvider(provider)`. Объект: `apiVersion: 1`, `id: 'skybricate'`, вкладка `properties`, готовый локализованный label и Font Awesome icon. Возвращённая функция снимает регистрацию.
- `mount({ target, tabId, context })` синхронный и возвращает идемпотентный cleanup. API v1: `schemaVersion: 1`, `surface: 'player'`, `surfaceId`, `tabId`, `actorId`, `isGM`, `revision`, `requestRemount`. Core заменяет frozen context и очищает прежний mount при смене actor/tab/context. Никаких обращений к приватным player/GM stores нет.
- В context **нет craftingSystemId**. Панель предоставляет собственный выбор сохранённой системы, начинает с первой системы корпуса. Выбор GM-окна, user.character и последний Actor из собственного редактора знаний не используются.
- Actor берётся только из `context.actorId` и `game.actors.get`. Авторизация повторяет штатный `isGatheringActorSelectableByUser`: существующий Actor и GM, `isOwner === true` либо `testUserPermission(user, 'OWNER') === true`. Нет Actor/потеря прав/удаление — пустой список с подсказкой. Синтетические Actor вне world collection не разрешаются через запасной путь.
- Системы и компоненты читаются через существующий строгий адаптер полного world setting `fabricate.craftingSystems`. Источник не заменяется draft, индексом GM-окна или частичным manager summary.

## Отображение и поиск

Панель показывает публичные названия компонентов выбранной системы, обычные назначения и, если включено `skybricate.showSpecialProperties`, особые назначения. Категории не участвуют. Знание разрешается только для ключа `actorId / craftingSystemId / componentId / propertyId`, независимо от типа назначения.

`playerRows` создаёт новую проекцию. Известное назначение содержит только имя и описание. Неизвестное назначение превращается в `null`, сохраняя только наличие слота. В DOM и поисковый массив не передаются скрытые названия, описания и propertyId. Нет скрытых title, dataset, option или ARIA со скрытыми свойствами. Имена и описания вставляются через textContent. Неизвестные слоты одинаковы и показывают число назначений. Названия/ID публичных систем и fallback ID публичных компонентов остаются видимыми.

Поиск без учёта регистра сопоставляет название компонента и известные названия/описания в текущей системе. Неизвестное свойство не может вызвать совпадение своим именем, описанием или ID. Совпавший компонент показывает все его видимые назначения с сохранением нейтральных слотов. Выключение особой зоны исключает особые тексты из DOM и поиска, сохраняя исходные назначения/знания и настройки алгоритма.

Это защита от случайного раскрытия в интерфейсе и поиске. Собственное world setting содержит полный каталог и знания, доступные клиентскому коду; этап 6 не вводит серверную секретность и не защищает от чтения через консоль или другого модуля.

## Обновления, ошибки и жизненный цикл

Смена персонажа приводит к stock remount с новым контекстом и новым поиском/выбором системы. Выбор системы внутри панели синхронно удаляет прежнее содержимое и сбрасывает поиск. Snapshot не кэшируется между mounts.

Изменения `skybricate.data` и `skybricate.showSpecialProperties` поступают через зарегистрированный Foundry `onChange`, включая репликацию settings на клиентах. Изменение полного корпуса Fabricate отслеживается `createSetting`/`updateSetting` с ключом `fabricate.craftingSystems`, включая первое сохранение world setting. `updateActor`, `deleteActor` и `updateUser` текущего пользователя повторно проверяют доступность Actor. Кнопка «Перечитать» повторяет чтение без записи. При удалении выбранной системы выбирается первая доступная; удалённые компоненты исчезают из отображения.

Перед каждым чтением старые строки очищаются. Пустые системы/компоненты/назначения, неизвестная версия, повреждённый корпус или snapshot дают нейтральную подсказку без текста исключения и без сброса хранилища. Обязательные проверки схемы выполняет DataStore; чтение совместимых схем 2/3 не сохраняет миграцию.

Cleanup удаляет подписки на собственные settings, Foundry hooks и DOM events и удаляет панель. Повторный mount того же target сначала освобождает прошлый mount. Снятие провайдера через возвращённый installPlayerProvider cleanup освобождает все его mounts, затем вызывает stock unregister. Повторные ready-события не регистрируют вторую вкладку.

Панель не вызывает set/create/update/delete/reconcile, не раскрывает знания и не меняет назначения, Actor, правила или данные Fabricate. Открытие игроком или GM также остаётся чтением.

## Автоматические проверки

- `node --test tests/regression.test.mjs`: **86/86 PASS**, включая 11 новых проверок этапа 6: anonymous projection, отсутствие скрытых данных во всём DOM, безопасный текст, поиск, actor/system смены, потерю доступа, hidden special, settings/refresh, пустые/битые данные, cleanup и одиночную регистрацию после ready. Также проверены RU/EN parity, точный runtime allowlist и побайтная воспроизводимость ZIP.
- `node tools/build.mjs`: **PASS**, 16 runtime-файлов; новый player-panel/player-provider включены, tests/docs/probes не поставляются. Это тот же build entrypoint, что `npm run build`; npm отсутствует в PATH текущего shell.
- `node --conditions=browser tools/check-fabricate-editor.mjs`: **PASS**, существующие штатные Svelte TagsCategoriesView/VocabularyPanel.
- `node --conditions=browser tools/check-fabricate-assignments.mjs`: **PASS**, оригинальные stock manager/repository, записи и сверка назначений.
- `node --conditions=browser tools/check-fabricate-player.mjs`: **PASS**, настоящий stock registry валидирует provider; скомпилированный PlayerExtensionHost монтирует наш UI, меняет actor/null context, освобождает connected target и слушатели. Проверены штатный OWNER contract, hidden special, unregister и отсутствие записи.

Ручной запуск Foundry не выполнялся. Реальная репликация между клиентами, темы и узкая ширина окна проверены только по контракту и тестовому DOM; stock probe не является запуском настоящего мира.
