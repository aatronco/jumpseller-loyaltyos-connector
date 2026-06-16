# RFC: Integración de Programa de Fidelización para Tiendas Jumpseller

**Estado:** Propuesta  
**Autor:** Producto — Alejandro Troncoso  
**Revisores:** Equipo de Apps  
**Fecha:** 2026-06-16  
**Repositorio de referencia (PoC):** `aatronco/jumpseller-loyaltyos-connector`

---

## Tabla de Contenidos

1. [Resumen Ejecutivo](#1-resumen-ejecutivo)
2. [Caso de Negocio](#2-caso-de-negocio)
3. [Solución Propuesta](#3-solución-propuesta)
4. [Evidencia de Validación](#4-evidencia-de-validación)
5. [Especificación de Integración](#5-especificación-de-integración)
6. [Requisitos No Funcionales](#6-requisitos-no-funcionales)
7. [Criterios de Aceptación](#7-criterios-de-aceptación)
8. [Fases de Entrega](#8-fases-de-entrega)
9. [Lo que NO se prescribe](#9-lo-que-no-se-prescribe)
10. [Apéndice](#10-apéndice)

---

## 1. Resumen Ejecutivo

Los programas de fidelización son uno de los mecanismos más efectivos para aumentar la frecuencia de compra y el valor de vida del cliente (LTV). Sin embargo, hoy ningún merchant de Jumpseller puede activar un programa de puntos sin recurrir a soluciones externas desconectadas de la plataforma, lo que genera fricción operacional y abandono del intent.

Este documento especifica una **Jumpseller App** que conecta cualquier tienda Jumpseller a un motor de fidelización ([LoyaltyOS](https://github.com/loyalty-os/loyaltyos)), cubriendo el ciclo completo: acumulación de puntos por compra, gestión de recompensas por el merchant, y canje de descuentos por el cliente en el checkout.

La integración fue validada en un prototipo funcional end-to-end. Este RFC entrega al equipo de Apps el **contrato técnico de integración** que debe cumplir la implementación de producción, sin prescribir la arquitectura interna ni la infraestructura de hosting.

---

## 2. Caso de Negocio

### 2.1 El Problema

| Dimensión | Situación actual |
|---|---|
| **Retención** | Los merchants Jumpseller no tienen herramienta nativa de puntos/fidelización |
| **Experiencia del cliente** | El comprador no tiene razones de marca para volver frente a precios equivalentes en otro sitio |
| **Operación del merchant** | Soluciones externas (Smile.io, Yotpo) son caras para el segmento SMB y no están integradas al checkout Jumpseller |
| **Ecosistema Jumpseller** | La App Store no ofrece ninguna solución de loyalty activa |

### 2.2 La Oportunidad

Un programa de puntos bien integrado impacta directamente tres métricas clave:

- **Tasa de recompra**: un cliente con puntos acumulados tiene un incentivo económico concreto para volver antes que el punto expire o que la competencia lo atraiga.
- **AOV (Average Order Value)**: los clientes que están cerca de un umbral de canje tienden a agregar más items al carrito.
- **Churn de merchants**: ofrecer una herramienta de fidelización nativa aumenta el costo de salida de la plataforma para el merchant.

### 2.3 Por qué este approach

En lugar de construir el motor de fidelización desde cero, esta propuesta se apoya en **LoyaltyOS**, un motor open-source auto-hospedable que maneja la lógica de puntos, eventos, recompensas y canjes. Jumpseller construye únicamente el **conector**: la capa que traduce eventos Jumpseller (órdenes pagadas, instalaciones de app) en operaciones LoyaltyOS, y expone al merchant un panel de configuración embebido.

Esto reduce el tiempo de desarrollo de meses a semanas y elimina la deuda de mantener la lógica de fidelización internamente.

---

## 3. Solución Propuesta

### 3.1 Visión del sistema

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Jumpseller                                  │
│                                                                     │
│  ┌──────────────┐   OAuth 2.0    ┌────────────────────────────────┐ │
│  │  Admin Panel │ ◄────────────► │                                │ │
│  │  (merchant)  │                │    LoyaltyOS Connector App     │ │
│  └──────┬───────┘   Webhooks     │    (esta especificación)       │ │
│         │          ────────────► │                                │ │
│  ┌──────▼───────┐                └──────────────┬─────────────────┘ │
│  │  Storefront  │   Widget JS                   │                   │
│  │  (comprador) │ ◄─────────────────────────────┘  API REST         │
│  └──────────────┘                                      │            │
└────────────────────────────────────────────────────────┼────────────┘
                                                         ▼
                                              ┌──────────────────────┐
                                              │      LoyaltyOS       │
                                              │  (motor de puntos,   │
                                              │   hospedado por      │
                                              │   Jumpseller)        │
                                              └──────────────────────┘
```

### 3.2 Alcance de esta especificación

| # | Funcionalidad | Descripción |
|---|---|---|
| F-01 | **Instalación OAuth** | El merchant instala la app y autoriza acceso a su tienda |
| F-02 | **Acumulación de puntos** | Por cada orden pagada, el comprador acumula puntos según la tasa configurada |
| F-03 | **Panel de administración** | El merchant configura tasa de conversión y gestiona el catálogo de recompensas desde el admin Jumpseller |
| F-04 | **Widget de storefront** | El comprador ve su balance de puntos y las recompensas disponibles en la tienda |
| F-05 | **Canje de recompensas** | El comprador canjea puntos por un cupón de descuento aplicable al checkout |
| F-06 | **Desinstalación** | Al desinstalar la app, los datos de la instalación se limpian correctamente |

### 3.3 Fuera de alcance (v1)

- Acumulación de puntos por acciones no-transaccionales (referidos, reseñas, cumpleaños)
- Programa de niveles/tiers (Bronze, Silver, Gold)
- Multi-moneda dentro de un mismo programa
- White-labeling del widget por parte del merchant

---

## 4. Evidencia de Validación

El prototipo `aatronco/jumpseller-loyaltyos-connector` implementa todos los flujos de F-01 a F-06 en una integración funcional contra la tienda `alejandrotest.jumpseller.com` y una instancia local de LoyaltyOS.

**Lo que fue validado en producción:**

- Instalación OAuth completa con registro de webhooks automático
- Acumulación de puntos al recibir el webhook `order_paid`
- Panel de admin embebido en el App Store de Jumpseller (nueva pestaña) con autenticación por HMAC capability-URL
- Widget JS inyectado vía JS App mostrando balance y recompensas en tiempo real
- Canje end-to-end: el comprador canjea puntos → LoyaltyOS descuenta el balance → Jumpseller crea el cupón de descuento → se retorna el código al widget

**Limitaciones conocidas del PoC (a resolver en producción):**

| Limitación del PoC | Expectativa de producción |
|---|---|
| LoyaltyOS corre en Docker local | LoyaltyOS hospedado y gestionado por infraestructura Jumpseller |
| Tunnel efímero (Cloudflare) para HTTPS | Dominio estable con TLS (Heroku/AWS/etc.) |
| SQLite como base de datos | Postgres u otro RDBMS gestionado |
| Token de admin estático (HMAC sin expiración) | Sesión firmada con expiración o cookie HttpOnly |
| Un solo LoyaltyOS compartido entre todas las tiendas | Confirmar si el modelo es multi-tenant o una instancia por merchant |

---

## 5. Especificación de Integración

Esta sección define el **contrato observable** que la implementación de producción DEBE cumplir. El cómo interno queda a criterio del equipo de Apps.

---

### 5.1 OAuth 2.0 — Instalación de la App

#### Flujo

```
Merchant hace clic en "Instalar" en la App Store
    │
    ▼
GET /oauth/install?store={storeId}
    │  El conector construye la URL de autorización Jumpseller
    ▼
302 → https://accounts.jumpseller.com/oauth/authorize?...
    │  Merchant aprueba permisos
    ▼
GET /oauth/callback?code={authCode}&state={csrfToken}
    │  Conector intercambia code por access_token + refresh_token
    │  Conector persiste la instalación en base de datos
    │  Conector registra webhooks necesarios vía API Jumpseller
    ▼
302 → {appUrl}/?store={storeId}&token={adminToken}
    (panel de admin)
```

#### Scopes requeridos

```
read_orders
read_customers
write_promotions
write_jsapps
write_hooks
read_store
```

#### Webhook que se auto-registra al instalar

| Evento | URL destino |
|---|---|
| `order_paid` | `{appUrl}/webhooks/order_paid` |

#### Persistencia mínima por instalación

| Campo | Tipo | Descripción |
|---|---|---|
| `storeId` | string (PK) | Identificador único de la tienda (slug) |
| `storeUrl` | string | URL base de la tienda |
| `accessToken` | string (cifrado) | Token OAuth de acceso |
| `refreshToken` | string (cifrado) | Token OAuth de refresco |
| `tokenExpiresAt` | timestamp | Expiración del access token |
| `scopes` | string | Scopes autorizados |
| `createdAt` | timestamp | Fecha de instalación |

> **Requisito de seguridad:** `accessToken` y `refreshToken` DEBEN almacenarse cifrados en reposo. En el PoC se usa AES-256-GCM con `TOKEN_ENCRYPTION_KEY`.

---

### 5.2 Webhook — Acumulación de Puntos

#### Endpoint

```
POST /webhooks/order_paid
```

#### Verificación de firma

Jumpseller firma el payload con HMAC-SHA256. El conector DEBE verificar la firma antes de procesar:

```
X-Jumpseller-Hmac-SHA256: {base64(HMAC-SHA256(webhookSecret, rawBody))}
```

Rechazar con `401` si la firma no coincide.

#### Lógica de acumulación

```
puntosGanados = floor(order.total / conversionRate)
```

Donde `conversionRate` es la tasa configurada por el merchant (defecto: 1 punto por cada 1000 CLP).

#### Idempotencia

Cada procesamiento de orden DEBE ser idempotente. La clave de idempotencia recomendada:

```
{storeId}:order_paid:{orderId}
```

Órdenes ya procesadas deben responder `200` sin duplicar puntos.

#### Flujo interno

```
1. Verificar firma HMAC → 401 si falla
2. Buscar instalación por storeId → 404 si no existe
3. Obtener o crear miembro LoyaltyOS por email del comprador
4. Calcular puntos según conversionRate del merchant
5. Registrar evento 'purchase' en LoyaltyOS con Idempotency-Key
6. Responder 200
```

---

### 5.3 Panel de Administración del Merchant

#### Acceso

El panel se abre desde Apps → Mis Apps → [nombre de la app] en el admin Jumpseller. El conector sirve una página HTML embebida o en nueva pestaña.

#### URL de acceso

```
GET /?store={storeId}&token={adminToken}
```

`adminToken` = `HMAC-SHA256(ADMIN_TOKEN_SECRET, storeId)` en hex (256 bits). Se embebe en la App URL configurada en el registro de la app.

> **Nota de seguridad:** El token es una capability URL estática. Para producción se recomienda elevar a JWT con expiración corta (`exp`) o sesión HttpOnly + SameSite=Strict.

#### Funcionalidades expuestas

**Tasa de conversión**

```
GET  /admin/config?store={storeId}
     → { conversionRate: number }

PATCH /admin/config?store={storeId}
     Body: { conversionRate: number }   // entero positivo
     → { conversionRate: number }
```

**Gestión de recompensas**

```
GET    /admin/rewards?store={storeId}
       → Reward[]

POST   /admin/rewards?store={storeId}
       Body: { name: string, couponValue: number, pointsCost: number }
       → Reward (201)

PATCH  /admin/rewards/:id?store={storeId}
       Body: Partial<{ name, couponValue, pointsCost }>
       → Reward

DELETE /admin/rewards/:id?store={storeId}
       → 204
```

Todos los endpoints de admin requieren el header:
```
X-Admin-Token: {adminToken}
```

#### Modelo Reward

```ts
interface Reward {
  id: string
  name: string
  pointsCost: number
  isActive: boolean
  stock: number
  description: string | null  // JSON: { couponType: 'fixed', couponValue: number }
}
```

---

### 5.4 Widget de Storefront

El widget se inyecta en la tienda vía una **Jumpseller JS App**. La JS App ejecuta el siguiente snippet en el storefront:

```html
<script src="{appUrl}/widget.js" async></script>
```

El script se auto-inicializa cuando detecta `window.__jsloyalty` o un elemento con `data-loyalty-widget`.

#### Endpoints que consume el widget

```
GET /widget/balance?email={email}&store={storeId}&customerId={id}
    → { points: number }

GET /widget/rewards?store={storeId}
    → Reward[]

POST /widget/redeem
     Body: { email, store, rewardId, customerId }
     → { couponCode: string, pointsUsed: number, remainingPoints: number }
```

#### Estados de error en `/widget/redeem`

| HTTP | Significado |
|---|---|
| 402 | Puntos insuficientes |
| 404 | Miembro o recompensa no encontrada |
| 422 | LoyaltyOS rechazó el canje (stock agotado, recompensa inactiva) |
| 502 | Error al crear el cupón en Jumpseller (canje ya registrado, no revertir) |

---

### 5.5 Cupones de Descuento (Jumpseller Promotions API)

Al canjear una recompensa, el conector DEBE crear un cupón en Jumpseller usando la API de Promotions:

```
POST /promotions.json
{
  "promotion": {
    "name": "{rewardName} — {email}",
    "type": "fix",
    "status": "enabled",
    "discount": {couponValue},
    "usage_limit": 1,
    "start_date": "{hoy}",
    "end_date": "{hoy + 30 días}"
  }
}
```

> **Gotcha conocido:** El campo `type` en la respuesta de Jumpseller devuelve `"percentage_off"` aunque se envíe `"fix"`. No confundir el campo de request con el de response. Documentado en el PoC.

---

### 5.6 Desinstalación

Jumpseller envía un evento de desinstalación cuando el merchant elimina la app. El conector DEBE:

1. Eliminar el registro de instalación de la base de datos
2. (Opcional v1) Notificar a LoyaltyOS para archivar el programa

---

### 5.7 Variables de Entorno Requeridas

| Variable | Descripción | Validación |
|---|---|---|
| `APP_URL` | URL pública del conector | URL válida |
| `JUMPSELLER_APP_ID` | Client ID de la app registrada | requerido |
| `JUMPSELLER_APP_SECRET` | Client Secret de la app | requerido |
| `JUMPSELLER_SCOPES` | Scopes OAuth | ver §5.1 |
| `JUMPSELLER_WEBHOOK_SECRET` | Secreto para verificar firmas HMAC | requerido |
| `ADMIN_TOKEN_SECRET` | Secreto independiente para tokens de admin | 64 hex chars (32 bytes) |
| `TOKEN_ENCRYPTION_KEY` | Clave para cifrar tokens OAuth en BD | 64 hex chars (32 bytes) |
| `LOYALTYOS_API_URL` | URL base de la instancia LoyaltyOS | URL válida |
| `LOYALTYOS_API_KEY` | API key de LoyaltyOS | requerido |
| `LOYALTYOS_PROGRAM_ID` | ID del programa en LoyaltyOS | requerido |
| `DATABASE_URL` | Conexión a base de datos | requerido |

> `JUMPSELLER_WEBHOOK_SECRET` y `ADMIN_TOKEN_SECRET` DEBEN ser valores independientes. Compartir la misma clave entre dominios de seguridad distintos invalida el aislamiento ante una eventual compromisión.

---

## 6. Requisitos No Funcionales

| Requisito | Descripción |
|---|---|
| **Idempotencia** | El procesamiento de cualquier webhook DEBE ser idempotente. Jumpseller puede entregar el mismo evento más de una vez. |
| **Cifrado en reposo** | `accessToken` y `refreshToken` DEBEN almacenarse cifrados. |
| **No exposición de secretos en logs** | El `token` de admin URL DEBE redactarse antes de escribir al log de acceso. |
| **HTTPS obligatorio** | Todos los endpoints del conector DEBEN servirse sobre HTTPS. |
| **Disponibilidad de webhooks** | El endpoint `/webhooks/order_paid` DEBE responder en < 5 s. Jumpseller considera el webhook fallido después de ese tiempo y reintenta. |
| **Validación de entrada** | Todo body y query param de API DEBE validarse antes de procesarse. Rechazar con `400` ante esquemas inválidos. |

---

## 7. Criterios de Aceptación

Una implementación se considera completa cuando:

- [ ] Un merchant puede instalar la app desde la App Store de Jumpseller sin intervención manual
- [ ] Al completar una orden, el comprador acumula puntos automáticamente; la acumulación es idempotente
- [ ] El merchant puede configurar la tasa de conversión desde el panel de admin sin salir de Jumpseller
- [ ] El merchant puede crear, editar y eliminar recompensas desde el panel de admin
- [ ] El comprador puede ver su balance de puntos en la tienda
- [ ] El comprador puede canjear puntos por un cupón válido que funciona en el checkout
- [ ] Al desinstalar la app, los datos de la instalación se eliminan
- [ ] Todos los endpoints de admin retornan `403` cuando se invoca sin un token válido
- [ ] El webhook retorna `401` si la firma HMAC no coincide
- [ ] Los access/refresh tokens no aparecen en texto plano en la base de datos ni en los logs

---

## 8. Fases de Entrega

### Fase 1 — MVP (recomendada como primer hito)

Flujos F-01, F-02, F-03 y F-06. El merchant puede instalar, ver el panel de admin y acumular puntos. Sin widget de storefront.

**Definición de done:** Un merchant real puede instalar la app, generar una orden de prueba y verificar que los puntos se acumularon desde el panel de admin.

### Fase 2 — Widget de storefront

Flujos F-04 y F-05. El comprador puede ver sus puntos y canjearlos.

**Definición de done:** Un comprador en la tienda puede ver su balance, seleccionar una recompensa, obtener un código de cupón y aplicarlo en el checkout.

### Fase 3 — Estabilización y observabilidad

- Manejo de refresh de tokens OAuth expirados
- Alertas si el webhook falla de forma sostenida
- Dashboard básico de métricas (instalaciones activas, puntos emitidos, canjes)

---

## 9. Lo que NO se prescribe

Este RFC define el **qué** (el comportamiento observable) pero no el **cómo** (la implementación interna). Las siguientes decisiones quedan completamente a criterio del equipo de Apps:

- **Lenguaje y framework**: el PoC usa TypeScript + Fastify, pero cualquier stack es válido
- **Infraestructura**: Heroku, AWS, Railway, Fly.io, o cualquier plataforma con HTTPS y PostgreSQL
- **ORM / acceso a datos**: Prisma (usado en el PoC), Drizzle, raw SQL, o cualquier alternativa
- **Estrategia de deploy**: CI/CD, Docker, buildpacks, etc.
- **Modelo de tenant de LoyaltyOS**: una instancia compartida multi-tenant o una instancia por merchant — ambas son compatibles con esta especificación, siempre que el `programId` correcto se use por instalación
- **Estrategia de sesiones del panel de admin**: el PoC usa HMAC capability-URL; producción puede elevar a JWT con expiración o cookies de sesión

---

## 10. Apéndice

### 10.1 Referencia de la prueba de concepto

| Artefacto | Ubicación |
|---|---|
| Repositorio del conector (PoC) | `github.com/aatronco/jumpseller-loyaltyos-connector` |
| Tienda de prueba | `alejandrotest.jumpseller.com` |
| LoyaltyOS (open source) | `github.com/loyalty-os/loyaltyos` |

El PoC tiene cobertura de tests unitarios e integración para todos los flujos especificados en §5. Se recomienda revisar los tests como documentación ejecutable del comportamiento esperado.

### 10.2 Endpoints LoyaltyOS utilizados

| Operación | Método | Path |
|---|---|---|
| Buscar miembro | `GET` | `/api/v1/members?search={email}` |
| Crear miembro | `POST` | `/api/v1/members` |
| Registrar evento de compra | `POST` | `/api/v1/events` |
| Consultar balance | `GET` | `/api/v1/members/{id}/balance` |
| Listar recompensas (admin) | `GET` | `/api/v1/admin/rewards` |
| Crear recompensa (admin) | `POST` | `/api/v1/admin/rewards` |
| Actualizar recompensa (admin) | `PATCH` | `/api/v1/admin/rewards/{id}` |
| Eliminar recompensa (admin) | `DELETE` | `/api/v1/admin/rewards/{id}` |

### 10.3 Glosario

| Término | Definición |
|---|---|
| **Merchant** | Dueño de la tienda Jumpseller que instala la app |
| **Comprador** | Cliente final que compra en la tienda del merchant |
| **Puntos** | Unidad de fidelización acumulada por compras |
| **Recompensa** | Beneficio canjeable por puntos (en esta v1: cupones de descuento de monto fijo) |
| **Tasa de conversión** | Monto en CLP necesario para acumular 1 punto |
| **Capability URL** | URL que incorpora un token de acceso como parámetro; quien tiene la URL tiene el acceso |
| **LoyaltyOS** | Motor de fidelización open-source que gestiona puntos, eventos y recompensas |
| **Connector** | Esta app: la capa de integración entre Jumpseller y LoyaltyOS |
