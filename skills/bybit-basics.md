---
name: bybit-basics
description: Основы Bybit V5 API — домены, категории, аутентификация
api_version: v5
---
# Bybit Basics

## Домены
- Demo trading: https://api-demo.bybit.com (наш агент работает ТОЛЬКО здесь)
- Mainnet: https://api.bybit.com (реальные деньги — агенту запрещены)

## Категории торгов
- spot — спотовая торговля (наша)
- linear — USDT-перпетуалы (фьючерсы, не используем)
- option — опционы (не используем)

## Аутентификация приватных endpoints
Заголовки: X-BAPI-API-KEY, X-BAPI-SIGN, X-BAPI-TIMESTAMP, X-BAPI-RECV-WINDOW.
Подпись = HMAC-SHA256(secret, timestamp + apiKey + recvWindow + params).
Вычисляется в коде (bybitHeaders), моделью никогда.

## Баланс
GET /v5/account/wallet-balance?accountType=UNIFIED — приватный endpoint.
