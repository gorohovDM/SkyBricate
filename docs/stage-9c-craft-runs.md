# Этап 9в: отложенные и многошаговые запуски

Подключены обычные delayed/multistep, свёрнутые цепочки (collapsed chain), смешанные временные шаги и progressive обычного Fabricate 1.9.10, pinned SHA `5bf36ddf950619317e41737acd3bfa1305591a26`. База `origin/main` — `354f565b498093f42123a697cc77d8bc1b3dcdc3`, исходный `codex/dev` — `1c42ecf5785b74d80a9b822ab84cc74b10e19e13`. Продолжены [выбор 9а](stage-9a-craft-adapter.md) и [применение 9б](stage-9b-craft-application.md); Fabricate не изменяется, этап 10 и запись знаний не начинались.

## Семантика шагов

Каждый реальный award получает свойства только от фактического расхода и единственной штатной проверки своего шага. Это совпадает с native `_createResultItems`: Fabricate не переносит расходы/эссенции предыдущего шага в следующий. Их произвольное накопление SkyBricate также не выполняет. Промежуточный переход без выданного Item не считается применением; реально выданный промежуточный Item получает собственные свойства и аудит. Последующая неудача цепочки не отменяет уже завершённый award предыдущего шага.

Для каждого шага заново действуют сохранённый порядок, allowlist, приоритет особых, лимит и сила по его stable outcome ID. Display name не заменяет ID. Выбор повторно подтверждается фактически потреблёнными UUID и количеством в границах плана, как в 9б. Разные шаги могут потреблять один частично оставшийся стек: аудит каждого содержит только количество этого шага.

Обычный timed START проверяет все возможные выбранные наборы до расхода, но не вызывает check. Штатный `_startTimedStep` расходует компоненты/валюту и сохраняет preparedConsumption, затем ставит gate. FINISH выполняет штатную проверку и выдачу без нового расхода, читая сохранённый состав, включая удалённые Item. Wait и world-time maturation не бросают кубы и не применяют свойства. Отмена/ошибка конфигурации FINISH оставляет native prepared run для повтора. Настоящая неудача и исключения сохраняют stock policy уже потраченных входов, без искусственного отката.

Timed alchemy START в данной версии потребляет только selection plan; `_consumeAlchemyExtraItems` в этом пути не вызывается. Поэтому submitted extras не становятся источниками SkyBricate и остаются в inventory. Immediate alchemy сохраняет прежнее поведение extras этапа 9а/9б.

Свёрнутая цепочка сначала ждёт один суммарный gate без расхода, затем выполняет отдельные шаги через native recursion. Каждая рекурсия получает независимый receiver. Проверки/расход/выдача не повторяются. Само ожидание не превращает цепочку в prepared timed step: enabled gates читаются при реальном выполнении, как в stock.

Progressive использует штатный числовой budget и результат native resolution; SkyBricate не создаёт именованных исходов. Outcome ID — null, сила всегда 1. `limitByCheck` запрещён, непустая `outcomeStrengths` также не проходит существующую проверку контракта. Award-nothing не создаёт audit. Это относится и к progressive timed FINISH.

## Сохранение provenance и отказ продолжения

Вместо изменения Fabricate или Actor методов используется отдельный receiver CraftingEngine и отдельный receiver его CraftingRunManager. Штатные cache, persist, history, gate, cleanup и cancellation остаются native. `getActiveRun`/`findActiveRunForRecipe` на локальном receiver захватывают именно объект native invocation: после потери cache два чтения документа могут возвращать разные объекты.

`run.skybricate` содержит version 1, actor/system/recipe/run IDs и fingerprint конфигурации. `step.skybricate` до native `_consumeIngredients` содержит index/stepId, строки `{componentId, itemUuid, actorUuid, quantity, kind}`, полный snapshot enabled gates эссенций и контрольную сумму. До удаления Item выполняется awaited native `updateRun`; отказ записи не допускает расхода. В локальном `markStepPrepared` добавляется fingerprint штатного preparedConsumption, который сохраняется тем же native persist. Whitelist Fabricate не расширяется; собственные данные лежат рядом с preparedConsumption, а не внутри него.

При продолжении проверяются binding, версия, конфигурация, текущий index/status, завершение предыдущих шагов, состав/quantities и совпадение с native consumedSummary. Provenance читается из сериализуемого снимка, не восстанавливается из названий или повторного поиска удалённых Item. Названия/описания свойств и команды macros в собственный контекст не копируются. Схема world setting остаётся 7.

Изменение рецепта, системы, назначений или правил после начала вызывает безопасный отказ до нового броска/расхода. Fingerprint намеренно консервативен: включает полные текущие определения системы/Sky и рецепта, поэтому изменения прочих полей, в том числе знаний/названий, также требуют восстановления исходного контекста или отмены native run и новой попытки. Исключены native `essence.enabled` и `requirements.time.enabled`: timed FINISH использует сохранённые полные enabled gates, а уже поставленный gate завершается и при выключенном live time feature. Независимые native essences сохраняют START quantities/gates; Sky свойства — заданную силу, порядок и тот же START gate.

Старые active/prepared runs без версии/контекста, повреждённые снимки, расход без завершённого prepared snapshot и неизвестные binding не продолжаются. Новый расход не производится, отсутствие provenance не считается пустым набором. Автоматическая миграция, восстановление по именам и возврат компонентов не выполняются; native cancellation остаётся доступной. Проверки fingerprint выявляют случайное повреждение/устаревание, это не криптографическая подпись и не граница авторизации. Actor flags доступны разрешённому клиентскому JS; серверная секретность не заявляется.

## Применение и подтверждение выдачи

Сохраняются правила 9б: independent native essences вне Sky allowlist/лимита, linked filtering, порядок macros/effects, последний result macro, feature/recipe gates, stacking veto для eligible набора, консервативная атрибуция и sources фактического расхода. Macro/effect paths и сила берутся из одного выбранного набора; новые roll/consume/create не добавляются.

Audit записывается только на выданный Item, оставшийся в Actor inventory. Для collapsed chain, возвращающей только последний award, предыдущий award подтверждается после успешного возврата native `_postCraftChatMessage` соответствующего шага. Остальные пути также сохраняют проверку возвращённого results. Общий finalizer помечает уже обработанный award, поэтому audit не записывается дважды. Исключения создания/эффектов/chat не оставляют завершённого аудита данного незавершённого шага. Аудит предыдущего завершённого шага сохраняется. UI/chat не получают скрытых названий; произвольные авторские macros отвечают за собственные сообщения.

## Проверки и ограничения

- `node --test tests/regression.test.mjs` — 117/117, включая JSON provenance, binding/corrupt/stale guards, progressive contract, immediate/alchemy regressions и точный runtime ZIP allowlist.
- `node tools/check-fabricate-craft.mjs` — unmodified stock Engine/Recipe/Resolution/Manager: delayed start/wait/world time/new manager/JSON reload/finish; удалённые источники, enabled/time toggles, independent native количества и порядок; ordinary/collapsed × immediate/mixed timed; раздельные расходы и промежуточные awards; no-output; timed alchemy extras и routed strength/limit; progressive immediate/timed/award-nothing; cancelled FINISH/retry; rolled failure, create/effect/chat exceptions; отказ provenance persistence; legacy/corrupt/changed assignments/rules/check/recipe; два независимых timed runs на одном Actor; прежний полный набор 9б.
- `node --conditions=browser tools/check-fabricate-recipes.mjs`, `node --conditions=browser tools/check-fabricate-editor.mjs`, `node tools/build.mjs` — совместимость редакторов и воспроизводимая runtime поставка с `craft-run-context.js`.

Ручной Foundry не запускался. Автоматические probes сериализуют persisted flags через JSON и создают новый настоящий CraftingRunManager, но не заменяют настоящий сервер/перезагрузку мира, document hooks и произвольные сторонние wrappers. Глобальная межклиентская блокировка одновременного продолжения одного native run не добавляется; права, документная persistence и такие гонки остаются в границах Fabricate/Foundry. Изменения сторонних macro документов не версионируются по их содержимому; для FINISH сохраняется native live lookup. На ошибки persistence/audit произвольные уже выполненные native side effects не откатываются.
