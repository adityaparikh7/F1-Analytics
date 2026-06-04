"""
F1 Pitwall — Backend Logging Configuration

Provides a custom ANSI colored formatter for terminal output.
"""

from __future__ import annotations

import logging
import sys
from typing import ClassVar


class ColoredFormatter(logging.Formatter):
    """Custom logging formatter that adds ANSI color codes to log levels."""

    GREY: ClassVar[str] = "\x1b[38;20m"
    BLUE: ClassVar[str] = "\x1b[34;20m"
    YELLOW: ClassVar[str] = "\x1b[33;20m"
    RED: ClassVar[str] = "\x1b[31;20m"
    BOLD_RED: ClassVar[str] = "\x1b[31;1m"
    RESET: ClassVar[str] = "\x1b[0m"

    # Format string: Time | Level (colored) | Name | Message
    FORMAT: str = "%(asctime)s | %(levelname_colored)-17s | %(name)s | %(message)s"

    LEVEL_COLORS: ClassVar[dict[int, str]] = {
        logging.DEBUG: GREY,
        logging.INFO: BLUE,
        logging.WARNING: YELLOW,
        logging.ERROR: RED,
        logging.CRITICAL: BOLD_RED,
    }

    def format(self, record: logging.LogRecord) -> str:
        # Add a colored version of the level name to the record
        color = self.LEVEL_COLORS.get(record.levelno, self.RESET)
        record.levelname_colored = f"{color}{record.levelname}{self.RESET}"
        
        # Use a temporary formatter to handle the actual string interpolation
        # using the colored format string
        formatter = logging.Formatter(self.FORMAT, datefmt="%H:%M:%S")
        return formatter.format(record)


def setup_logging(level: str = "INFO") -> None:
    """Sets up the root logger with the ColoredFormatter."""
    numeric_level = getattr(logging, level.upper(), logging.INFO)
    
    # Configure root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(numeric_level)
    
    # Clear existing handlers
    if root_logger.hasHandlers():
        root_logger.handlers.clear()
        
    # Create stream handler (stderr by default)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(ColoredFormatter())
    
    root_logger.addHandler(handler)
    
    # Silence some noisy third-party loggers if needed
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("fastapi").setLevel(logging.INFO)
