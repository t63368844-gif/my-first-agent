---
name: order-types
description: Типы ордеров Bybit и семантика qty для spot market
api_version: v5
---
# Order Types

## Market Buy (spot)
- Тратим USDT, получаем base coin (BTC).
- qty = СУММА В USDT + marketUnit="quoteCoin".
- Пример: qty="100", marketUnit="quoteCoin" → потратить 100 USDT.

## Market Sell (spot)
- Продаём base coin, получаем USDT.
- qty = КОЛИЧЕСТВО BTC + marketUnit="baseCoin".
- Пример: qty="0.001", marketUnit="baseCoin" → продать 0.001 BTC.

## Limit
- Указываем price; исполнится при достижении цены.
- qty всегда в base coin.
- timeInForce: GTC (до отмены), IOC (немедленно или отмена).

## Частые ошибки
- retCode 170140: сумма ордера ниже минимума (для spot demo ~5-10 USDT).
- retCode 170003: неизвестный параметр (например quoteOrderQty вместо qty+marketUnit).
