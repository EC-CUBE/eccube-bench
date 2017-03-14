localectl set-locale LANG=ja_JP.utf8
yum update -y
yum install -y wget vim httpd
systemctl disable firewalld
systemctl stop firewalld
ab -V
