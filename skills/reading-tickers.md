---
name: reading-tickers
description: Как читать данные /v5/market/tickers и instruments-info
api_version: v5
---
# Reading Market Data

## /v5/market/tickers (spot)
- lastPrice — последняя цена сделки
- price24hPcnt — изменение за 24ч (доли: 0.02 = +2%)
- high24h / low24h — диапазон суток
- turnover24h — объём в USDT

## /v5/market/instruments-info (spot)
- lotSizeFilter.minOrderQty / maxOrderQty — лимиты количества
- priceFilter.tickSize — шаг цены
- status: Trading / Delivering / Closed

## Интерпретация
- |price24hPcnt| > 0.05 → высокая волатильность: предупреждать пользователя перед ордером.
- minOrderQty × lastPrice ≈ минимальная сумма ордера (сверять с retCode 170140).
