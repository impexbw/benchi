from setuptools import setup, find_packages

with open("requirements.txt") as f:
    install_requires = f.read().strip().split("\n")

setup(
    name="erpnext_ai_bots",
    version="1.0.0",
    description="AI Agent platform for ERPNext",
    author="Benchi",
    author_email="info@benchi.io",
    packages=find_packages(),
    zip_safe=False,
    include_package_data=True,
    install_requires=install_requires,
)
