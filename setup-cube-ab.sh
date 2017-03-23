ip addr add 192.168.0.1/24 dev eth1
localectl set-locale LANG=ja_JP.utf8
yum update -y
yum install -y httpd
systemctl disable firewalld
systemctl stop firewalld
ab -V
