@echo off
title Dutch Legions - Local Chat Server
echo Installeren van benodigde library...
pip install websockets --quiet
echo.
echo Starten...
python server.py
pause
