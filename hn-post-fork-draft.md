# "La idea es buena, ahora voy a hacer que funcione cojonudamente bien" — Auditoría + propuesta de fork para Wellread MCP

La semana pasada publiqué una auditoría de Wellread, la "memoria colectiva de investigación" para agentes IA. El TLDR era: buena arquitectura, ahorro de tokens sobreestimado, overhead real que nadie contabiliza.

Hoy voy más allá. Hice el ejercicio de forkear mentalmente el código y diseñar las mejoras que harían que los números cuadren de verdad. Con cálculos reales, token por token.

## Estado actual: las cuentas que no cuadran

Primero, el baseline honesto. Wellread calcula el ahorro así:

```
tokens_saved = raw_tokens - response_tokens
```

Un research típico tiene ~8K raw_tokens (lo que costó investigar) y ~1.5K response_tokens (la síntesis guardada). El badge dice: "¡Ahorraste ~8K tokens!" Pero el overhead real es:

| Concepto | Tokens | Frecuencia |
|---|---|---|
| Hook inyectado en contexto | ~500 | Cada turno de la sesión |
| Schemas MCP (3 tools) | ~1,800 | Una vez por sesión (amortizado) |
| Tool call de búsqueda (output) | ~200 | Cada búsqueda |
| Resultado de búsqueda (input) | ~2,000 | Cada búsqueda (5 resultados) |
| Badge (output) | ~100 | Cada búsqueda |
| Background Agent para contribuir | ~8,000 | Cada miss/check/partial |

### Escenario realista: sesión de 20 turnos, 10 preguntas técnicas

Asumiendo una red en crecimiento (no madura): 4 hits frescos, 2 checks, 4 misses.

**Con Wellread actual:**

| Escenario | Cantidad | Tokens/unidad | Total |
|---|---|---|---|
| Hits frescos | 4 | +5,000 neto | +20,000 |
| Checks (busca + verifica web + Agent) | 2 | -13,000 | -26,000 |
| Misses (overhead + Agent contribución) | 4 | -11,200 | -44,800 |
| Hook en contexto (500 × 20 turnos) | 1 | -10,000 | -10,000 |
| **TOTAL SESIÓN** | | | **-60,800 tokens** |

Leíste bien. **La sesión PIERDE 60K tokens con Wellread instalado** en una red que aún no tiene masa crítica. El badge acumuló "¡Ahorraste ~32K tokens!" mientras la realidad era -60K.

Incluso en una red madura (7 hits, 2 checks, 1 miss), el neto es apenas +10K — no los +56K que diría el badge.

## Las 8 mejoras que cambiarían todo

### 1. Matar el hook — mover el workflow a las descripciones de herramientas

**El problema:** El hook inyecta ~500 tokens de instrucciones en CADA turno como `system-reminder`. En una sesión de 20 turnos, son 10,000 tokens de input extra solo por la inyección repetida.

**La solución:** Las descripciones de herramientas MCP se cargan UNA vez por sesión y se cachean. El workflow completo cabe en la descripción del tool `search`. Claude Code ya soporta deferred tool loading — las descripciones ni siquiera se cargan hasta que se necesitan.

```typescript
// ANTES: hook.sh inyecta 500 tokens por turno
// DESPUÉS: todo vive en la descripción del tool

server.tool(
  "search",
  `Search collective research memory. ALWAYS call before web search 
   or implementing technical solutions. Generate 3 query variants.
   
   After receiving results:
   - 🟢 fresh: use directly, skip web search
   - 🟡 check: use + one quick verify, then call contribute(verify_id)
   - 🔴 stale: re-research, then contribute(started_from_ids)
   
   If no results or you did additional research → call contribute
   with your findings (inline, not in background agent).`,
  { /* schemas */ },
  handler
);
```

El hook pasa a ser un nudge mínimo de 2 líneas (~50 tokens):

```bash
#!/bin/bash
INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty')
if [ ${#PROMPT} -lt 20 ]; then exit 0; fi
echo "wellread: search before researching. Skip for non-technical prompts."
```

**Ahorro: ~450 tokens/turno × 20 turnos = 9,000 tokens/sesión.**

### 2. Resultados adaptativos — no siempre devolver 5

**El problema:** `hybridSearch(keywords, embedding, 5)` siempre pide 5 resultados. Un hit con similarity 0.92 no necesita 4 resultados extra de relleno que ocupan ~1,500 tokens adicionales en contexto.

**La solución:** Lógica de corte adaptativo server-side:

```typescript
// search.ts — después de obtener resultados
const results = await hybridSearch(keywords, embedding, 5);

// Adaptive cutoff: strong match → fewer results
let filtered: SearchResult[];
if (results[0]?.similarity > 0.82) {
  filtered = results.slice(0, 1);  // Solo el top
} else if (results[0]?.similarity > 0.65) {
  filtered = results.filter(r => r.similarity > 0.55).slice(0, 3);
} else {
  filtered = results;  // Todos (partial match territory)
}
```

**Ahorro en hits fuertes: ~1,200-1,800 tokens por búsqueda.**

### 3. Formato compacto de resultados

**El problema:** Cada resultado tiene formato verboso con separadores, labels, y metadatos expandidos:

```
--- Result 1 (id: a1b2c3d4-..., similarity: 0.823) ---
[contenido completo]
Sources: https://long-url-1.com/path, https://long-url-2.com/path  
Gaps (unexplored): gap one · gap two · gap three
Researched: 2024-03-15
Freshness: 🟢 fresh (12d old, stable)
Tags: nextjs, auth, middleware, server-components
```

**La solución:** Formato denso optimizado para LLMs (que no necesitan formato bonito):

```typescript
const formatted = results.map((r, i) => {
  const f = freshnessResults[i];
  const srcList = r.sources.slice(0, 3).join(","); // Top 3 sources max
  const gapList = (gapsData[i]?.data?.gaps ?? []).slice(0, 3).join(",");
  return `[${f.label}|${f.age_days}d|${r.similarity.toFixed(2)}] ${r.content}\nsrc:${srcList}${gapList ? `|gaps:${gapList}` : ""}`;
}).join("\n---\n");
```

Los LLMs parsean esto igual de bien. Los humanos no leen el tool result directamente.

**Ahorro: ~30% por resultado. En un resultado de 600 tokens → ~180 tokens. En 5 resultados: ~900 tokens.**

### 4. ELIMINAR el background Agent — contribuir inline

**El problema nuclear.** Cada contribución lanza un background Agent de Claude. Eso es una sesión API COMPLETA:
- System prompt: ~5,000 tokens
- Tool schemas cargados: ~1,800 tokens  
- Thinking del modelo: ~1,000-5,000 tokens
- Tool call contribute: ~500 tokens output
- Tool result: ~50 tokens input
- **Total: ~8,000-12,000 tokens POR CONTRIBUCIÓN**

El workflow actual dice "⛔ DO NOT call contribute directly in main thread." ¿Por qué? Porque el tool result quedaría en el contexto de la conversación. Pero ese result es literalmente `"Research saved to collective memory. Thank you."` — **30 tokens**.

**La solución:** Contribuir inline al final de la respuesta.

```
// En las instrucciones del tool:
"After researching, call contribute directly (not in background agent).
 The response is minimal and won't bloat your context."
```

Coste inline: ~500 tokens output (el tool call) + ~30 tokens input (el result).
Coste background Agent: ~8,000-12,000 tokens.

**Ahorro por contribución: ~7,500-11,500 tokens.**

En una sesión con 6 contribuciones (4 misses + 2 checks): **ahorro de 45,000-69,000 tokens.**

Este cambio SOLO ya invierte la economía de Wellread.

### 5. Bloom filter client-side para predecir misses

**El problema:** En una red joven, la mayoría de búsquedas son misses. Cada miss cuesta ~3,000 tokens de overhead (search call + result + badge) para descubrir que no hay nada.

**La solución:** El servidor mantiene un bloom filter de todos los `search_surface` indexados. El hook lo descarga una vez por sesión (~2-16KB, cabe en un archivo local) y lo consulta ANTES de decidir si hacer la búsqueda MCP.

```bash
#!/bin/bash
INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty')
if [ ${#PROMPT} -lt 20 ]; then exit 0; fi

# Check bloom filter (updated hourly)
BLOOM="$HOME/.wellread/bloom.bin"
if [ -f "$BLOOM" ]; then
  # Simple keyword check against bloom filter
  LIKELY_HIT=$(echo "$PROMPT" | wellread-bloom-check "$BLOOM")
  if [ "$LIKELY_HIT" = "miss" ]; then
    echo "wellread: no prior research likely. Research normally, then contribute."
    exit 0
  fi
fi

echo "wellread: search before researching."
```

Con un bloom filter de false positive rate 1%:
- Misses predichos correctamente: ~99% de misses reales
- En esos casos: 0 tokens de search overhead
- Solo se paga el contribute inline al final: ~500 tokens

**Ahorro por miss predicho: ~2,500 tokens (evitas la búsqueda vacía).**

### 6. Badge honesto — net savings, no gross

**El problema:** El badge dice "¡Ahorraste ~8K tokens!" cuando raw_tokens era 8K. Pero el usuario pagó ~3K de overhead para obtener ese resultado. Y si fue un "check", pagó overhead + web search, así que no ahorró nada.

**La fórmula honesta:**

```typescript
// Solo para hits frescos (el único caso con ahorro real):
const searchOverhead = estimateSearchOverhead(results.length);
// ~200 (tool call) + responseTokensInResult + 100 (badge)
const webSearchAvoided = estimateWebSearchCost(results[0].raw_tokens);
// Estimación conservadora: raw_tokens * 1.2 (incluye tool calls de web search)

const netSaved = webSearchAvoided - searchOverhead;

// Para checks: ahorro parcial (usaste el cache + verificaste ligero)
const checkSavings = webSearchAvoided * 0.3 - searchOverhead;
// Asumimos que verificar es 70% más barato que investigar desde cero

// Para misses: ahorro negativo, no mostrar "saved"
if (effectiveMatch === "none") {
  badge = "🗺️ First research — saving for the next one.";
}
```

El badge pasa de:
```
🔥 You just saved ~8K tokens!
```
A:
```
🔥 Net: ~5.2K tokens saved (8K research, 2.8K overhead)
```

**Impacto: cero en tokens, enorme en credibilidad.** Cuando los números son honestos, la gente confía y adopta más.

### 7. Opt-out por consulta

**El problema:** No hay forma de saltar Wellread para una pregunta específica sin desinstalarlo.

**La solución:** Dos caracteres en el hook:

```bash
# Skip si el prompt contiene "!nw" (no wellread)
if echo "$PROMPT" | grep -qF '!nw'; then exit 0; fi
```

El usuario escribe: `!nw cómo funciona mi AuthProvider custom` → cero overhead de Wellread.

**Ahorro: 100% del overhead en consultas donde el usuario SABE que no habrá hit** (código propio, lógica de negocio, debugging específico).

### 8. Filtrado inteligente en el hook

**El problema:** El hook actual solo filtra por longitud (>20 chars). `"refactoriza la función handleAuth"` (36 chars) dispara Wellread, pero nunca va a haber un hit relevante para una refactorización de código propio.

**La solución:** Heurísticas básicas en bash:

```bash
# Skip para acciones locales que no necesitan research
SKIP_PATTERNS="refactor|rename|move|delete|commit|push|merge|rebase|lint|format|fix typo|add test|remove"
if echo "$PROMPT" | grep -qiE "^($SKIP_PATTERNS)"; then exit 0; fi

# Skip si parece referir archivos locales
if echo "$PROMPT" | grep -qE '\.(ts|js|py|go|rs|jsx|tsx|vue|css|html)\b'; then exit 0; fi
```

No es perfecto (false negatives posibles), pero elimina ~30-40% de disparos inútiles.

**Ahorro estimado: ~1,500 tokens/turno × 6-8 turnos filtrados = ~10,000 tokens/sesión.**

## Las cuentas con todas las mejoras aplicadas

### Escenario: misma sesión de 20 turnos, 10 preguntas técnicas, red en crecimiento

(4 hits frescos, 2 checks, 4 misses)

**Overhead por componente:**

| Concepto | Actual | Mejorado | Ahorro |
|---|---|---|---|
| Hook por turno | 500 × 20 = 10,000 | 50 × 12* = 600 | 9,400 |
| Búsqueda (hit fresco, 1 result) | 2,500 × 4 = 10,000 | 900 × 4 = 3,600 | 6,400 |
| Búsqueda (check) | 2,500 × 2 = 5,000 | 900 × 2 = 1,800 | 3,200 |
| Búsqueda (miss) | 2,500 × 4 = 10,000 | 0** × 4 = 0 | 10,000 |
| Background Agent (contribución) | 8,000 × 6 = 48,000 | 0 | 48,000 |
| Inline contribute | 0 | 500 × 6 = 3,000 | -3,000 |
| **Total overhead** | **83,000** | **9,000** | **74,000** |

*\* 12 turnos: 8 turnos filtrados por heurísticas (no-técnicos o acciones locales)*
*\*\* Bloom filter predice miss → sin búsqueda*

**Balance neto de la sesión:**

| Escenario | Actual | Mejorado |
|---|---|---|
| 4 hits × ahorro bruto (6,500 c/u) | +26,000 | +26,000 |
| 2 checks × ahorro parcial | -26,000* | +5,200** |
| Overhead total | -83,000 | -9,000 |
| **NETO** | **-83,000** | **+22,200** |

*\* Actual: overhead + web search completa + background Agent*
*\*\* Mejorado: cache usado + verify ligero inline, sin background Agent. Web search parcial ~3K vs ~8K completa.*

### El swing: de perder 83K tokens a ahorrar 22K

Eso son **105,000 tokens de diferencia** por sesión. En Opus 4.6 ($5/MTok input):

- **Actual: +$0.42 de coste extra por sesión** (Wellread te cuesta dinero)
- **Mejorado: -$0.11 de ahorro por sesión** (Wellread te ahorra dinero)
- **Con red madura (7 hits): -$0.31 de ahorro por sesión**

No es una fortuna, pero al menos el signo es correcto.

## El cambio que más mueve la aguja

Si solo pudieras implementar UN cambio, elimina el background Agent. Los números:

| Solo este cambio | Tokens ahorrados por sesión |
|---|---|
| Eliminar background Agent (6 contribuciones) | ~48,000 - 3,000 = **45,000 tokens** |
| Todo lo demás combinado | ~29,000 tokens |

El background Agent es el 60% del problema. Un solo cambio — contribuir inline en el hilo principal — invierte la economía de Wellread de negativa a positiva.

## Bonus: el endpoint contribute-only

Idea salvaje pero funcional: añadir un modo donde el usuario NO busca, solo contribuye. Para cuando SABES que eres el primero investigando algo.

```typescript
// Nuevo tool: contribute_only
server.tool(
  "contribute_only",
  `Save research without searching first. Use when you already did 
   research and want to share it. No search overhead.`,
  { /* mismos schemas que contribute */ },
  handler
);
```

El hook podría detectar patterns como "investiga X desde cero" o "busca en la documentación de Y" y sugerir contribute-only en vez de search → miss → contribute.

**Ahorro: 100% del search overhead (~3,000 tokens) en misses auto-detectados.**

## La métrica que falta: coste de oportunidad

Ninguna de estas cuentas incluye el coste de oportunidad de la ejecución secuencial. "⛔ NO llamar herramientas en paralelo con search" significa que en cada pregunta técnica, el agente espera 1-3 segundos a que Wellread responda ANTES de empezar a trabajar.

En una sesión de 10 preguntas técnicas, son 10-30 segundos de latencia añadida. No es un coste en tokens, pero es un coste en experiencia. Si el resultado es un miss (y con bloom filter lo sabrías de antemano), esos segundos son puro desperdicio.

La solución: si el bloom filter predice hit, buscar primero (vale la pena esperar). Si predice miss, investigar directamente en paralelo.

## Resumen del fork propuesto

| # | Cambio | Complejidad | Impacto (tokens/sesión) |
|---|---|---|---|
| 1 | Hook mínimo → workflow en tool desc | Baja | -9,000 |
| 2 | Resultados adaptativos (1-3-5) | Baja | -6,400 |
| 3 | Formato compacto | Baja | -2,700 |
| 4 | **Eliminar background Agent** | **Media** | **-45,000** |
| 5 | Bloom filter client-side | Alta | -10,000 |
| 6 | Badge honesto (net savings) | Baja | 0 (credibilidad) |
| 7 | Opt-out por consulta (!nw) | Trivial | Variable |
| 8 | Filtrado inteligente en hook | Baja | -10,000 |
| | **TOTAL** | | **~-83,000** |

Los cambios 1, 2, 3, 4, 6 y 7 son implementables en un fin de semana. El bloom filter necesita más trabajo (endpoint server-side, distribución, actualización). El filtrado de hook es quick & dirty pero efectivo.

## Conclusión

Wellread tiene la arquitectura correcta para resolver un problema real. El sistema de frescura, el versionado con linaje, la búsqueda híbrida — todo eso es sólido. El problema no es el diseño, es la economía de la integración con el cliente.

El 90% del desperdicio viene de dos decisiones:
1. Inyectar instrucciones por hook en cada turno (en vez de en las tool descriptions)
2. Forzar un background Agent para cada contribución (en vez de un tool call inline de 30 tokens)

Arregla esas dos cosas y Wellread pasa de costarte tokens a ahorrártelos. El resto de mejoras son optimizaciones que multiplican el ahorro.

La propuesta es buena. Solo necesita que alguien haga las cuentas con papel y lápiz antes de escribir el badge.

---

*Los cálculos asumen Claude Opus 4.6 ($5/$25 por MTok), sesiones de 20 turnos con 10 preguntas técnicas, y una red con ~40% hit rate. Tu caso concreto variará. El código de Wellread es open-source (AGPL-3.0) en github.com/mnlt/wellread.*
